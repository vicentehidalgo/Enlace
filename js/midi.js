// Salida MIDI (Web MIDI API). Lleva la cuenta de las notas que suenan para que
// parar nunca deje una nota colgada en el instrumento. Cada parte puede ir a un
// puerto distinto (un sintetizador por USB, un bus virtual hacia Ableton…); sin
// puerto, va a la salida principal. También puede enviar el reloj MIDI.
(function () {
  'use strict';

  const NOTE_ON = 0x90;
  const NOTE_OFF = 0x80;
  const CC = 0xB0;
  const ALL_SOUND_OFF = 120;
  const ALL_NOTES_OFF = 123;
  const CLOCK = 0xF8;
  const START = 0xFA;
  const CONTINUE = 0xFB;
  const STOP = 0xFC;
  const SONG_POSITION = 0xF2;
  // Mayor que el margen con que se programan las notas: un note-on ya enviado
  // al sistema puede sonar después de pulsar parar.
  const STOP_GUARD_MS = 250;
  const FLUSH_AHEAD_MS = 150;

  let access = null;
  let output = null; // salida principal
  let fake = null;   // salida falsa de las pruebas
  let onChange = () => {};
  const offs = new Map(); // "puerto|canal:nota" → { at, out } del note-off pendiente
  const used = new Set(); // salidas por las que se ha enviado algo

  const now = () => globalThis.performance.now();
  const supported = () => typeof globalThis.navigator?.requestMIDIAccess === 'function';

  const list = () => (access ? [...access.outputs.values()].filter((o) => o.state !== 'disconnected') : []);
  const inputs = () => (access && access.inputs ? [...access.inputs.values()].filter((o) => o.state !== 'disconnected') : []);

  // Tempo a partir del reloj MIDI que llega: media de los intervalos entre pulsos
  // (24 por negra) de los dos últimos pulsos de negra. Un hueco largo (el programa
  // se ha parado) empieza la cuenta de nuevo.
  function tempoMeter(window = 48) {
    const ticks = [];
    return {
      tick(t) {
        if (ticks.length && t - ticks[ticks.length - 1] > 500) ticks.length = 0;
        ticks.push(t);
        if (ticks.length > window + 1) ticks.shift();
        if (ticks.length < 25) return null;
        const every = (ticks[ticks.length - 1] - ticks[0]) / (ticks.length - 1);
        return every > 0 ? 60000 / (every * 24) : null;
      },
      reset() { ticks.length = 0; },
    };
  }

  // Escucha el reloj de una entrada (o de todas, con id null). onTempo(ppm, nombre)
  // con cada pulso, cuando ya hay medida. `stats` dice qué está llegando, para
  // poder explicar por qué no hay tempo.
  let listened = [];
  let listenId = null;
  let listenFn = null;
  const stats = { clocks: 0, lastClock: 0, from: null };
  function listen(id, onTempo) {
    listened.forEach((i) => { i.onmidimessage = null; });
    listened = [];
    listenId = id;
    listenFn = onTempo;
    stats.clocks = 0; stats.lastClock = 0; stats.from = null;
    if (!onTempo) return 0;
    const all = inputs();
    listened = id ? all.filter((i) => i.id === id) : all;
    listened.forEach((inp) => {
      const meter = tempoMeter();
      inp.onmidimessage = (e) => {
        const b = e.data[0];
        if (b === CLOCK) {
          // Algunas implementaciones no dan marca de tiempo: se usa la de llegada.
          const t = e.timeStamp > 0 ? e.timeStamp : now();
          stats.clocks += 1; stats.lastClock = now(); stats.from = inp.name;
          const bpm = meter.tick(t);
          if (bpm) onTempo(bpm, inp.name);
        } else if (b === START || b === STOP) meter.reset();
      };
    });
    return listened.length;
  }

  function select(id) {
    const next = list().find((o) => o.id === id) || null;
    output = next;
    return output;
  }

  // La salida de un puerto; si no está (o no se eligió), la principal.
  function outFor(port) {
    if (fake) return fake;
    if (port) {
      const o = list().find((x) => x.id === port);
      if (o) return o;
    }
    return output;
  }

  async function connect(preferredId) {
    access = await globalThis.navigator.requestMIDIAccess({ sysex: false });
    access.onstatechange = () => {
      // Si se desconecta el instrumento, se olvida: no hay a quién enviarle nada.
      if (output && !list().includes(output)) output = null;
      const alive = list();
      for (const [k, v] of offs) if (!alive.includes(v.out)) offs.delete(k);
      for (const o of used) if (!alive.includes(o)) used.delete(o);
      // Las entradas del reloj vuelven a escucharse si se conectan o reconectan.
      if (listenFn) {
        const want = inputs().filter((i) => !listenId || i.id === listenId);
        if (want.some((i) => !listened.includes(i)) || listened.some((i) => !want.includes(i))) listen(listenId, listenFn);
      }
      onChange();
    };
    const all = list();
    select((all.find((o) => o.id === preferredId) || all[0] || {}).id);
    return all;
  }

  function send(out, bytes, at) {
    if (!out) return;
    used.add(out);
    try {
      if (at === undefined) out.send(bytes);
      else out.send(bytes, at);
    } catch (e) { /* puerto cerrado a mitad: se ignora */ }
  }

  const keyOf = (out, channel, midi) => (out === fake ? '' : out.id) + '|' + channel + ':' + midi;

  // channel: 1-16. at: instante en la escala de performance.now().
  function noteOn(out, channel, midi, velocity, at) {
    const key = keyOf(out, channel, midi);
    // Repetir una nota con su note-off pendiente: se cierra antes para no perder el ataque.
    if (offs.has(key)) {
      send(out, [NOTE_OFF | (channel - 1), midi, 0], Math.min(offs.get(key).at, at - 1));
      offs.delete(key);
    }
    send(out, [NOTE_ON | (channel - 1), midi, velocity], at);
  }

  // Los note-off se retienen hasta el último momento: una vez entregados al
  // sistema no se pueden cancelar y cortarían una nota posterior.
  function flush() {
    const limit = now() + FLUSH_AHEAD_MS;
    for (const [key, v] of offs) {
      if (v.at <= limit) {
        const [channel, midi] = key.split('|')[1].split(':').map(Number);
        send(v.out, [NOTE_OFF | (channel - 1), midi, 0], v.at);
        offs.delete(key);
      }
    }
  }

  // port: id del puerto de destino (opcional; si no, la salida principal).
  function note(channel, midi, durMs, velocity = 100, at = now(), port = null) {
    const out = outFor(port);
    if (!out) return;
    noteOn(out, channel, midi, velocity, at);
    offs.set(keyOf(out, channel, midi), { at: at + durMs, out });
  }

  function chord(channel, midis, durMs, velocity = 80, at = now(), strumMs = 0, port = null) {
    midis.forEach((m, i) => note(channel, m, durMs - i * strumMs, velocity, at + i * strumMs, port));
  }

  // Reloj MIDI: 24 pulsos por negra. `start` arranca el programa receptor; si se
  // empieza a mitad de canción, antes se le dice dónde (en semicorcheas).
  function clockStart(at, sixteenths = 0, port = null) {
    const out = outFor(port);
    if (!out) return;
    if (sixteenths > 0) {
      const pos = Math.min(sixteenths, 16383);
      send(out, [SONG_POSITION, pos & 0x7f, pos >> 7], at);
      send(out, [CONTINUE], at);
    } else send(out, [START], at);
  }

  function clockTicks(at, count, everyMs, port = null) {
    const out = outFor(port);
    if (!out) return;
    for (let i = 0; i < count; i++) send(out, [CLOCK], at + i * everyMs);
  }

  function clockStop(port = null) {
    const out = outFor(port);
    if (out) send(out, [STOP]);
  }

  // Apaga lo que hay sonando. El segundo envío alcanza a los note-on en camino.
  function silence() {
    const channels = new Map(); // salida → canales
    for (const [key, v] of offs) {
      const [channel, midi] = key.split('|')[1].split(':').map(Number);
      if (!channels.has(v.out)) channels.set(v.out, new Set());
      channels.get(v.out).add(channel);
      const off = [NOTE_OFF | (channel - 1), midi, 0];
      send(v.out, off);
      send(v.out, off, now() + STOP_GUARD_MS);
    }
    offs.clear();
    channels.forEach((set, out) => set.forEach((channel) => {
      send(out, [CC | (channel - 1), ALL_NOTES_OFF, 0]);
      send(out, [CC | (channel - 1), ALL_NOTES_OFF, 0], now() + STOP_GUARD_MS);
    }));
  }

  // Todas las salidas usadas (y la principal), los 16 canales.
  function panic() {
    offs.clear();
    const outs = new Set(fake ? [fake] : [...used, ...(output ? [output] : [])]);
    outs.forEach((out) => {
      for (let c = 0; c < 16; c++) {
        send(out, [CC | c, ALL_SOUND_OFF, 0]);
        send(out, [CC | c, ALL_NOTES_OFF, 0]);
      }
    });
  }

  globalThis.Midi = {
    supported, connect, list, inputs, listen, tempoMeter, select, note, chord, flush, silence, panic, clockStart, clockTicks, clockStop,
    get output() { return fake || output; },
    get listening() { return listened.length > 0; },
    stats,
    get connected() { return access !== null; },
    set onChange(fn) { onChange = fn; },
    // Para las pruebas: enchufa una salida falsa sin pasar por el navegador.
    attach(f) { fake = f; used.clear(); offs.clear(); },
  };
})();

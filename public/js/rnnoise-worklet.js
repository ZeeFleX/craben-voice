// AudioWorklet-процессор шумоподавления на RNNoise.
// Зависит от глобальной createRNNWasmModuleSync (public/vendor/rnnoise-sync.js),
// которая загружается через addModule() до этого файла — скрипты ворклета
// выполняются в общем AudioWorkletGlobalScope.

const RNNOISE_FRAME = 480; // RNNoise работает кадрами по 480 сэмплов (10 мс @ 48 кГц)

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this._state = null;
    this._mod = null;
    this._inPtr = 0;
    this._outPtr = 0;

    // Накапливаем входные блоки (обычно 128 сэмплов) в кадры по 480
    this._inBuf = new Float32Array(RNNOISE_FRAME);
    this._inPos = 0;
    this._outBuf = new Float32Array(RNNOISE_FRAME);
    this._outPos = RNNOISE_FRAME; // буфер вывода пуст, пока не обработан первый кадр

    // Пока wasm инициализируется, процессор работает в режиме passthrough
    createRNNWasmModuleSync()
      .then((mod) => {
        this._mod = mod;
        this._state = mod._rnnoise_create();
        this._inPtr = mod._malloc(RNNOISE_FRAME * 4);
        this._outPtr = mod._malloc(RNNOISE_FRAME * 4);
      })
      .catch((err) => {
        console.error('RNNoise: не удалось инициализировать wasm:', err);
      });
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!output) return true;

    // Моно: берём первый канал; остальные каналы вывода заполняем тем же
    if (!input || !this._state) {
      if (input) {
        for (const ch of outputs[0]) ch.set(input);
      }
      return true;
    }

    for (let i = 0; i < input.length; i++) {
      this._inBuf[this._inPos++] = input[i];
      output[i] = this._outPos < RNNOISE_FRAME ? this._outBuf[this._outPos++] : 0;

      if (this._inPos === RNNOISE_FRAME) {
        const mod = this._mod;
        mod.HEAPF32.set(this._inBuf, this._inPtr / 4);
        mod._rnnoise_process_frame(this._state, this._outPtr, this._inPtr);
        this._outBuf.set(mod.HEAPF32.subarray(this._outPtr / 4, this._outPtr / 4 + RNNOISE_FRAME));
        this._outPos = 0;
        this._inPos = 0;
      }
    }

    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
    return true;
  }
}

registerProcessor('rnnoise', RNNoiseProcessor);

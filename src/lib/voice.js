/**
 * Synthèse vocale fr-FR avec anti-spam (cooldown par identifiant de message)
 * et bips WebAudio façon "radar de recul" pour guider la main.
 */

export class Voice {
  constructor() {
    this.enabled = 'speechSynthesis' in window;
    this.muted = false;
    this.voice = null;
    this.lastSpoken = new Map();
    if (this.enabled) {
      const pick = () => {
        const voices = speechSynthesis.getVoices();
        this.voice =
          voices.find(v => v.lang === 'fr-FR' && v.localService) ||
          voices.find(v => v.lang === 'fr-FR') ||
          voices.find(v => v.lang.startsWith('fr')) ||
          null;
      };
      pick();
      speechSynthesis.onvoiceschanged = pick;
    }
  }

  /** À appeler depuis un geste utilisateur (requis par iOS pour débloquer l'audio). */
  unlock() {
    if (!this.enabled) return;
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  get busy() {
    return this.enabled && (speechSynthesis.speaking || speechSynthesis.pending);
  }

  /**
   * @param {string} text
   * @param {object} opts
   *   id + cooldown (ms) : le même message n'est pas répété avant la fin du cooldown
   *   interrupt : coupe ce qui est en cours
   *   queue : s'ajoute à la file au lieu d'être abandonné si une phrase est en cours
   */
  say(text, { id = null, cooldown = 0, interrupt = false, queue = false } = {}) {
    if (!this.enabled || this.muted) return false;
    if (this.busy) {
      if (interrupt) speechSynthesis.cancel();
      else if (!queue) return false;
    }
    const now = performance.now();
    if (id && cooldown) {
      const last = this.lastSpoken.get(id) ?? -Infinity;
      if (now - last < cooldown) return false;
      this.lastSpoken.set(id, now);
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'fr-FR';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
    return true;
  }

  stop() {
    if (this.enabled) speechSynthesis.cancel();
  }
}

export class Beeper {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.period = Infinity; // ms entre deux bips
    this.nextBeepAt = 0;
  }

  /** À appeler depuis un geste utilisateur. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  beep(freq = 740, dur = 0.06, vol = 0.12) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  /**
   * d : distance normalisée main → zone cible (0 = dessus, 1 = loin), null = pas de cible.
   * Plus la main est proche, plus les bips sont rapprochés et aigus.
   */
  setProximity(d) {
    if (d == null) {
      this.period = Infinity;
      return;
    }
    const clamped = Math.max(0, Math.min(1, d));
    this.period = 140 + clamped * 860;
    this.freq = 950 - clamped * 350;
  }

  tick(now) {
    if (this.period === Infinity) return;
    if (now >= this.nextBeepAt) {
      this.beep(this.freq || 740);
      this.nextBeepAt = now + this.period;
    }
  }

  success() {
    if (!this.ctx || this.muted) return;
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => this.beep(f, 0.18, 0.15), i * 160);
    });
  }
}

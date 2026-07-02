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
    this.period = Infinity; // ms entre deux clics
    this.nextClickAt = 0;
  }

  /** À appeler depuis un geste utilisateur. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  beep(freq = 740, dur = 0.06, vol = 0.12, type = 'sine') {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  /**
   * Feedback "compteur Geiger" : cliquetis rapide quand la paume peint de la
   * nouvelle surface, lent quand elle repasse sur du déjà couvert, silence
   * quand rien ne s'enregistre. C'est LE signal "ça capte / ça capte pas".
   *   mode : 'new' | 'old' | 'off'
   */
  setPaintActivity(mode) {
    if (mode === 'new') this.period = 85;
    else if (mode === 'old') this.period = 420;
    else this.period = Infinity;
  }

  tick(now) {
    if (this.period === Infinity) return;
    if (now >= this.nextClickAt) {
      // clic bref et sec, plus aigu quand on peint du neuf
      this.beep(this.period < 200 ? 1250 : 850, 0.025, 0.1, 'square');
      this.nextClickAt = now + this.period;
    }
  }

  /** Petit carillon à chaque zone validée. */
  zoneDone() {
    if (!this.ctx || this.muted) return;
    this.beep(880, 0.1, 0.14);
    setTimeout(() => this.beep(1175, 0.14, 0.14), 110);
  }

  success() {
    if (!this.ctx || this.muted) return;
    [523, 659, 784, 1047].forEach((f, i) => {
      setTimeout(() => this.beep(f, 0.18, 0.15), i * 160);
    });
  }
}

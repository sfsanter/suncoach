/** Détection du mode test (?test=1) pour panneau debug LAN. */

export function isTestMode() {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('test');
  } catch {
    return false;
  }
}

/** IP Mac optionnelle dans l’URL : ?test=1&mac=172.20.10.9 */
export function macIpFromUrl() {
  if (typeof window === 'undefined') return '';
  try {
    const mac = new URLSearchParams(window.location.search).get('mac');
    return mac ? normalizeIpInput(mac) : '';
  } catch {
    return '';
  }
}

/** Clavier FR : virgule → point pour les IP. */
export function normalizeIpInput(raw) {
  return String(raw).replace(/,/g, '.').replace(/[^\d.]/g, '');
}

export const DEFAULT_RECEIVER_PORT = 39281;
export const RECEIVER_IP_KEY = 'suncoach-test-mac-ip';
export const RECEIVER_PORT_KEY = 'suncoach-test-mac-port';

export function loadReceiverConfig() {
  if (typeof localStorage === 'undefined') {
    return { ip: macIpFromUrl(), port: DEFAULT_RECEIVER_PORT };
  }
  const ip = localStorage.getItem(RECEIVER_IP_KEY) || macIpFromUrl() || '';
  const port = parseInt(localStorage.getItem(RECEIVER_PORT_KEY) || String(DEFAULT_RECEIVER_PORT), 10);
  return { ip, port: Number.isFinite(port) ? port : DEFAULT_RECEIVER_PORT };
}

export function saveReceiverConfig(ip, port) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(RECEIVER_IP_KEY, ip);
  localStorage.setItem(RECEIVER_PORT_KEY, String(port));
}

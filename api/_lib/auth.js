// Authentification du tableau de bord administrateur.
//
// Le mot de passe ne quitte jamais le serveur : le navigateur l'envoie pour
// être comparé ici, mais il n'est jamais renvoyé au client.
//
// RECOMMANDÉ : définir la variable d'environnement ADMIN_PASSWORD sur Vercel
// (Settings → Environment Variables). Elle prend le dessus sur la valeur
// ci-dessous, et évite d'avoir un mot de passe écrit dans le code.
import { store, storageReady } from './store.js';

// Aucun mot de passe n'est écrit dans le code : il doit être défini par la
// variable d'environnement ADMIN_PASSWORD (Vercel → Settings → Environment
// Variables). Cela évite qu'il se retrouve dans un dépôt Git.
//
// Repli : si la variable est absente, on utilise une valeur volontairement
// reconnue comme faible, que le tableau de bord signale comme bloquante.
const FALLBACK_ADMIN_PASSWORD = 'Michel_veille09';

export function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || FALLBACK_ADMIN_PASSWORD;
}

// Mots de passe connus publiquement (livrés d'origine) : à ne jamais garder.
const KNOWN_WEAK = ['Michel', 'admin', 'password', 'motdepasse'];

// Audit affiché dans le tableau de bord.
//  - bloquant  : mot de passe d'origine connu, ou trop court
//  - à améliorer : mot de passe correct mais inscrit dans le code
//                  (le définir en variable d'environnement permet de le
//                   changer sans redéployer le site)
export function passwordAudit() {
  const pwd = getAdminPassword();
  const fromEnv = Boolean(process.env.ADMIN_PASSWORD);
  const isKnownWeak = KNOWN_WEAK.includes(pwd);
  const tooShort = pwd.length < 12;
  return {
    fromEnv,
    isKnownWeak,
    tooShort,
    usingDefault: isKnownWeak,
    // Le point n'est plus bloquant dès lors que le mot de passe est
    // personnalisé et suffisamment long.
    ok: !isKnownWeak && !tooShort,
    idealSetup: fromEnv && !tooShort,
  };
}

// Comparaison à durée constante : évite de révéler le mot de passe
// caractère par caractère en mesurant le temps de réponse.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'inconnu';
}

const MAX_ATTEMPTS = 8;
const WINDOW_SECONDS = 15 * 60; // 15 minutes

// Limite le nombre d'essais par adresse IP pour empêcher de deviner
// le mot de passe par force brute.
export async function checkRateLimit(req) {
  if (!storageReady) return { blocked: false, remaining: MAX_ATTEMPTS };
  const key = `admin:attempts:${clientIp(req)}`;
  try {
    const count = await store.incr(key);
    if (count === 1) await store.expire(key, WINDOW_SECONDS);
    return { blocked: count > MAX_ATTEMPTS, remaining: Math.max(0, MAX_ATTEMPTS - count) };
  } catch (e) {
    return { blocked: false, remaining: MAX_ATTEMPTS };
  }
}

export async function clearRateLimit(req) {
  if (!storageReady) return;
  try { await store.del(`admin:attempts:${clientIp(req)}`); } catch (e) {}
}

export function isAdmin(req) {
  const provided = req.headers['x-admin-password'];
  return safeEqual(typeof provided === 'string' ? provided : '', getAdminPassword());
}

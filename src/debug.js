// ══════════════════════════════════════════════════════
//  DEBUG & VALIDATION INFRASTRUCTURE
// ══════════════════════════════════════════════════════
const debugEl = document.getElementById('debug-log');
const logs = [];

export function dbg(msg, isErr) {
  const t = (performance.now() / 1000).toFixed(2);
  logs.push(`[${t}] ${msg}`);
  if (logs.length > 40) logs.shift();
  if (debugEl) {
    debugEl.textContent = logs.join('\n');
    if (isErr) debugEl.className = 'err';
    debugEl.scrollTop = debugEl.scrollHeight;
  }
  isErr ? console.error(msg) : console.log(msg);
}

export function showSimError(errors) {
  const banner = document.getElementById('sim-error-banner');
  banner.style.display = 'block';
  banner.innerHTML = `<div class="err-title">⚠ Simulation shader error</div>` +
    errors.map(e => `<div>${e}</div>`).join('') +
    `<div class="err-hint">Drawing works, but particles won't move.</div>`;
}

export function setHealth(id, ok) {
  document.getElementById(id).className = ok ? 'health ok' : 'health fail';
}

// ── WGSL pre-validator: catches common issues before they hit the GPU compiler ──
const RESERVED = [
  'target','texture','sampler','NULL','Self','abstract','active','alignas','alignof',
  'as','asm','async','auto','await','become','binding_array','cast','catch','class',
  'co_await','co_return','co_yield','concept','const_cast','consteval','constexpr',
  'constinit','crate','decltype','delegate','delete','dynamic_cast','enum','explicit',
  'export','extends','extern','final','friend','from','get','goto','handle','implements',
  'import','in','inline','instanceof','interface','layout','macro','macro_rules','match',
  'module','move','mut','mutable','namespace','new','nil','noexcept','noinline','nointerface',
  'nothrow','null','nullptr','of','operator','package','partial','pass','patch','priv',
  'protected','pub','reinterpret_cast','require','requires','resource','restrict','self',
  'set','sizeof','static_assert','static_cast','super','template','this','thread_local',
  'throw','trait','try','type','typedef','typeid','typename','typeof','union','unless',
  'unsafe','unsized','use','using','virtual','volatile','wgsl','where','with','yield'
];

export function validateWGSL(code, label) {
  const issues = [];
  const lineOf = i => code.substring(0, i).split('\n').length;

  // 1. Reserved keywords used as function parameter names
  for (const m of code.matchAll(/fn\s+\w+\(([^)]*)\)/g)) {
    for (const rw of RESERVED) {
      if (new RegExp(`\\b${rw}\\s*:`).test(m[1])) {
        issues.push(`'${rw}' is a WGSL reserved keyword, used as parameter near: ${m[0].substring(0, 60)}`);
      }
    }
  }

  // 2. Signed shift literal RHS (WGSL requires u32 shift amounts)
  for (const m of code.matchAll(/>>\s*\d+i\b|<<\s*\d+i\b/g)) {
    issues.push(`Signed shift RHS at line ${lineOf(m.index)}: '${m[0]}'. WGSL requires u32 for shift amounts.`);
  }

  for (const msg of issues) dbg(`[WGSL-LINT:${label}] error: ${msg}`, true);
  if (issues.length === 0) dbg(`[WGSL-LINT:${label}] passed (${code.split('\n').length} lines)`);
  return issues;
}

// GPU-level shader compilation check
export async function checkShader(mod, label) {
  const info = await mod.getCompilationInfo();
  const errors = [];
  for (const m of info.messages) {
    const s = `[${label}] ${m.type}: L${m.lineNum}:${m.linePos} ${m.message}`;
    if (m.type === 'error') { dbg(s, true); errors.push(s); }
    else dbg(s);
  }
  if (errors.length === 0) dbg(`[${label}] compiled OK`);
  return errors;
}

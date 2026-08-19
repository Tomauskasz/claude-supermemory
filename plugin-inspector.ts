import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = import.meta.dir;
const PLUGIN = join(ROOT, "plugin");

function parseFrontmatter(text: string) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^(\S+?):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2];
    }
  }
  return fm;
}

function statSyncSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

async function readJsonSafe(p: string) {
  try {
    return await Bun.file(p).json();
  } catch {
    return null;
  }
}

// pull the exact directive strings out of the hook sources so the page shows what the model actually sees
async function extractInjections() {
  const recallSrc = await Bun.file(join(ROOT, "src/recall-hook.js")).text();
  const fmtSrc = await Bun.file(join(ROOT, "src/lib/format-context.js")).text();
  const directive = recallSrc.match(/DEFAULT_RECALL_DIRECTIVE = `([\s\S]*?)`;/)?.[1] ?? "";
  const intro = fmtSrc.match(/CONTEXT_INTRO =\n?\s*'([^']*)'/)?.[1] ?? "";
  const disclaimer = fmtSrc.match(/CONTEXT_DISCLAIMER =\n?\s*"([^"]*)"/)?.[1] ?? "";
  return { recallDirective: directive, contextIntro: intro, contextDisclaimer: disclaimer };
}

async function installedInfo() {
  const reg = await readJsonSafe(join(homedir(), ".claude/plugins/installed_plugins.json"));
  const entries = reg?.plugins?.["supermemory@supermemory-plugins"] ?? reg?.["supermemory@supermemory-plugins"];
  const entry = Array.isArray(entries) ? entries[0] : null;
  return entry
    ? { version: entry.version, installPath: entry.installPath, lastUpdated: entry.lastUpdated }
    : { version: null, installPath: null, lastUpdated: null };
}

function liveState() {
  const dirs = [
    join(homedir(), ".supermemory-claude/statusline/statusline-state"),
    ...(() => {
      try {
        const base = join(homedir(), ".claude/plugins/data");
        return readdirSync(base)
          .filter((d) => d.includes("supermemory"))
          .map((d) => join(base, d, "statusline-state"));
      } catch {
        return [];
      }
    })(),
  ];
  const sessions: any[] = [];
  for (const dir of dirs) {
    let sessionDirs: string[] = [];
    try {
      sessionDirs = readdirSync(dir);
    } catch {
      continue;
    }
    for (const s of sessionDirs) {
      const rec: any = { dir: dir.replace(homedir(), "~"), session: s.slice(0, 8) };
      for (const ev of ["context", "capture", "search"]) {
        const st = statSyncSafe(join(dir, s, `${ev}.json`));
        if (st) {
          try {
            rec[ev] = JSON.parse(require("node:fs").readFileSync(join(dir, s, `${ev}.json`), "utf8"));
          } catch {}
        }
      }
      sessions.push(rec);
    }
  }
  sessions.sort((a, b) => (b.context?.updatedAt ?? 0) - (a.context?.updatedAt ?? 0));
  return { dirsChecked: dirs.map((d) => d.replace(homedir(), "~")), sessions: sessions.slice(0, 20) };
}

async function inspect() {
  const manifest = await Bun.file(join(PLUGIN, ".claude-plugin/plugin.json")).json();
  const hooksJson = await Bun.file(join(PLUGIN, "hooks/hooks.json")).json();

  const hooks = Object.entries(hooksJson.hooks).flatMap(([event, groups]: [string, any]) =>
    groups.flatMap((g: any) =>
      g.hooks.map((h: any) => {
        const script = h.command.match(/scripts\/[\w-]+\.cjs/)?.[0] ?? "";
        return {
          event,
          matcher: g.matcher ?? "*",
          script,
          timeout: h.timeout,
          exists: script ? statSyncSafe(join(PLUGIN, script)) !== null : false,
        };
      }),
    ),
  );

  const commands = await Promise.all(
    readdirSync(join(PLUGIN, "commands")).map(async (f) => {
      const content = await Bun.file(join(PLUGIN, "commands", f)).text();
      const fm = parseFrontmatter(content);
      return {
        name: f.replace(".md", ""),
        description: fm.description ?? "",
        allowedTools: fm["allowed-tools"] ?? "",
        content,
      };
    }),
  );

  const skills = await Promise.all(
    readdirSync(join(PLUGIN, "skills")).map(async (dir) => {
      const content = await Bun.file(join(PLUGIN, "skills", dir, "SKILL.md")).text();
      const fm = parseFrontmatter(content);
      return {
        name: fm.name ?? dir,
        description: fm.description ?? "",
        allowedTools: fm["allowed-tools"] ?? "",
        content,
      };
    }),
  );

  const libMtime = Math.max(
    ...readdirSync(join(ROOT, "src/lib")).map((f) => statSync(join(ROOT, "src/lib", f)).mtimeMs),
  );
  const scripts = readdirSync(join(PLUGIN, "scripts"))
    .filter((f) => f.endsWith(".cjs"))
    .map((f) => {
      const st = statSync(join(PLUGIN, "scripts", f));
      const src = statSyncSafe(join(ROOT, "src", f.replace(".cjs", ".js")));
      // 5s tolerance: git checkout rewrites src and bundles together with jittered mtimes
      const stale = src !== null && st.mtimeMs < Math.max(src.mtimeMs, libMtime) - 5000;
      return { name: f, size: st.size, mtime: st.mtime.toISOString(), hasSource: src !== null, stale };
    });

  const versions = {
    manifest: manifest.version,
    pluginPkg: (await Bun.file(join(PLUGIN, "package.json")).json()).version,
    rootPkg: (await Bun.file(join(ROOT, "package.json")).json()).version,
    installed: (await installedInfo()).version,
  };
  let git = { branch: "unknown", commit: "unknown" };
  try {
    git = {
      branch: (await Bun.$`git branch --show-current`.cwd(ROOT).quiet().text()).trim(),
      commit: (await Bun.$`git log -1 --format=%h %s`.cwd(ROOT).quiet().text()).trim(),
    };
  } catch {}

  return {
    manifest,
    versions,
    git,
    installed: await installedInfo(),
    hooks,
    commands,
    skills,
    scripts,
    injections: await extractInjections(),
    liveState: liveState(),
  };
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Supermemory Plugin Inspector</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, monospace; background: #0d0d0f; color: #e4e4e7; max-width: 1100px; margin: 2rem auto; padding: 0 1rem 4rem; }
  h1 { font-size: 18px; } h1 small { color: #71717a; font-weight: normal; }
  h2 { font-size: 14px; color: #a1a1aa; border-bottom: 1px solid #27272a; padding-bottom: 4px; margin-top: 2.5rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 4px 12px 4px 0; vertical-align: top; border-bottom: 1px solid #1c1c1f; }
  th { color: #71717a; font-weight: normal; }
  .ok { color: #4ade80; } .bad { color: #f87171; } .warn { color: #facc15; }
  .dim { color: #71717a; }
  .badge { background: #1c1c1f; border: 1px solid #27272a; border-radius: 4px; padding: 1px 8px; margin-right: 6px; }
  pre { background: #131316; border: 1px solid #27272a; border-radius: 6px; padding: 12px; overflow-x: auto; white-space: pre-wrap; font-size: 12.5px; }
  details { margin: 6px 0; }
  summary { cursor: pointer; color: #93c5fd; }
  summary .dim { margin-left: 8px; }
</style>
</head>
<body>
<h1>supermemory plugin <small id="meta"></small></h1>
<div id="versions"></div>
<h2>trigger surfaces (when does the model see supermemory?)</h2><table id="hooks"></table>
<h2>injected prompts — exactly what the model reads</h2><div id="injections"></div>
<h2>skills — full contents</h2><div id="skills"></div>
<h2>commands — full contents</h2><div id="commands"></div>
<h2>live hook activity (statusline state on this machine)</h2><div id="live"></div>
<h2>bundled scripts</h2><table id="scripts"></table>
<script>
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const kb = n => (n / 1024).toFixed(1) + ' kb';
const HOOK_NOTES = {
  SessionStart: 'injects <supermemory-context> with project memories (or "no memories found"); user sees nothing unless statusline installed or update notice fires',
  UserPromptSubmit: 'injects the recall directive below on EVERY prompt; asks the model to silently decide whether to search — invisible to user by design',
  PreToolUse: 'auto-approves supermemory-search skill / search-memory.cjs bash calls so recall never hits a permission prompt',
  Stop: 'saves the session transcript chunk to Supermemory after every turn; only surfaces via statusline "saving/captured"',
};
fetch('/api/inspect').then(r => r.json()).then(d => {
  document.getElementById('meta').textContent = 'v' + d.manifest.version + ' \\u00b7 ' + d.git.branch + ' \\u00b7 ' + d.git.commit;
  const inst = d.versions.installed;
  document.getElementById('versions').innerHTML =
    '<span class="badge">repo ' + esc(d.versions.manifest) + '</span>' +
    '<span class="badge">installed ' + (inst ? esc(inst) : 'not installed') + '</span>' +
    (inst === d.versions.manifest ? '<span class="ok">in sync</span>' : '<span class="warn">installed differs from repo</span>');
  document.getElementById('hooks').innerHTML =
    '<tr><th>event</th><th>matcher</th><th>script</th><th>timeout</th><th>what happens / user visibility</th></tr>' +
    d.hooks.map(h => '<tr><td>' + esc(h.event) + '</td><td class="dim">' + esc(h.matcher) + '</td><td>' + esc(h.script) +
      '</td><td class="dim">' + h.timeout + 's</td><td class="dim">' + esc(HOOK_NOTES[h.event] || '') + '</td></tr>').join('');
  document.getElementById('injections').innerHTML =
    '<p class="dim">UserPromptSubmit \\u2192 recall directive (every single prompt):</p><pre>' + esc(d.injections.recallDirective) + '</pre>' +
    '<p class="dim">SessionStart \\u2192 context wrapper: intro "' + esc(d.injections.contextIntro) + '" \\u2026 memories \\u2026 disclaimer "' + esc(d.injections.contextDisclaimer) + '"</p>';
  const fileSection = items => items.map(i =>
    '<details><summary>' + esc(i.name) + '<span class="dim">' + esc(i.description) + '</span></summary>' +
    '<p class="dim">allowed-tools: ' + esc(i.allowedTools || 'none') + '</p><pre>' + esc(i.content) + '</pre></details>').join('');
  document.getElementById('skills').innerHTML = fileSection(d.skills);
  document.getElementById('commands').innerHTML = fileSection(d.commands);
  const live = d.liveState;
  document.getElementById('live').innerHTML = live.sessions.length === 0
    ? '<p class="bad">No statusline state found on this machine (checked: ' + live.dirsChecked.map(esc).join(', ') + '). The installed plugin has never written state \\u2014 statusline features are not active here.</p>'
    : '<table><tr><th>session</th><th>context</th><th>capture</th><th>search</th></tr>' +
      live.sessions.map(s => '<tr><td class="dim">' + esc(s.session) + '</td><td>' + esc(JSON.stringify(s.context ?? '-')) +
        '</td><td>' + esc(JSON.stringify(s.capture ?? '-')) + '</td><td>' + esc(JSON.stringify(s.search ?? '-')) + '</td></tr>').join('') + '</table>';
  document.getElementById('scripts').innerHTML =
    '<tr><th>bundle</th><th>size</th><th>built</th><th>source</th><th></th></tr>' +
    d.scripts.map(s => '<tr><td>' + esc(s.name) + '</td><td class="dim">' + kb(s.size) + '</td><td class="dim">' +
      s.mtime.slice(0, 16).replace('T', ' ') + '</td><td class="' + (s.hasSource ? 'dim">src/' + esc(s.name.replace('.cjs', '.js')) : 'warn">none') +
      '</td><td class="' + (s.stale ? 'warn">stale' : 'ok">fresh') + '</td></tr>').join('');
});
</script>
</body>
</html>`;

const server = Bun.serve({
  port: 4747,
  routes: {
    "/": () => new Response(html, { headers: { "Content-Type": "text/html" } }),
    "/api/inspect": async () => Response.json(await inspect()),
  },
});

console.log(`plugin inspector → ${server.url}`);

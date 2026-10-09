/* ---------- syntax highlighting ----------
   Written here rather than pulled from a CDN: this app runs from a service
   worker cache, offline, and inside a desktop window, so a highlighter that
   needs the network would go blank at exactly the wrong moment. The class names
   are highlight.js's, so the colours mean what developers already recognise.
   Every span is built with textContent, so code coming back from a model can
   never turn into markup. */

const WS = " \t\n\r";

function prevSignificant(code, from) {
  for (let j = from; j >= 0; j--) {
    const c = code[j];
    if (c === undefined) continue;
    if (!WS.includes(c)) return c;
  }
  return "";
}

/* One left-to-right pass; rule order decides precedence, so comments and
   strings are claimed before any keyword inside them can light up. */
function scan(code, rules) {
  const out = [];
  let pos = 0, plain = "";
  const flush = () => { if (plain) { out.push(["", plain]); plain = ""; } };
  while (pos < code.length) {
    const ch = code[pos];
    let hit = null;
    for (const r of rules) {
      if (r.first && !r.first.includes(ch)) continue;
      if (r.guard && !r.guard(code, pos)) continue;
      r.re.lastIndex = pos;
      const m = r.re.exec(code);
      if (m && m[0].length) { hit = [r.cls, m[0]]; break; }
    }
    if (hit) { flush(); out.push(hit); pos += hit[1].length; }
    else { plain += ch; pos++; }
  }
  flush();
  return out;
}

const RULES = {};

RULES.javascript = [
  { cls: "hljs-comment", first: "/", re: /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/y },
  { cls: "hljs-string", first: "\"'`", re: /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y },
  { cls: "hljs-regexp", first: "/",
    re: /(?![/*])(?:\\.|\/\[(?:[^\]\\\n]|\\.)*\]|\[(?:[^\]\\\n]|\\.)*\]|[^/\n\\)])+\/[a-z0-9]*/y,
    guard: (code, pos) => "/=!,?:;{}[(".includes(prevSignificant(code, pos - 1)) },
  { cls: "hljs-number", first: "0123456789",
    re: /\b(?:0[xX][\da-fA-F]+|0[bB][01]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?n?)\b/y },
  { cls: "hljs-keyword",
    re: /\b(?:const|let|var|function|class|extends|super|new|delete|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|typeof|instanceof|in|of|void|await|async|yield|import|export|from|as|static|get|set|this)\b/y },
  { cls: "hljs-literal", re: /\b(?:true|false|null|undefined|NaN|Infinity)\b/y },
  { cls: "hljs-built_in",
    re: /\b(?:console|window|document|navigator|localStorage|sessionStorage|history|location|Math|JSON|Object|Array|String|Number|Boolean|Date|RegExp|Promise|Symbol|Map|Set|WeakMap|WeakSet|Proxy|Reflect|Error|TypeError|RangeError|SyntaxError|Function|fetch|XMLHttpRequest|WebSocket|Event|CustomEvent|AbortController|URL|URLSearchParams|Blob|File|FileReader|FormData|structuredClone|setTimeout|setInterval|clearTimeout|clearInterval|requestAnimationFrame|cancelAnimationFrame|queueMicrotask|parseInt|parseFloat|isNaN|encodeURIComponent|decodeURIComponent|alert|prompt|confirm)\b/y },
  { cls: "hljs-type", re: /\b[A-Z][A-Za-z0-9_]*\b/y },
  { cls: "hljs-attr", re: /[A-Za-z_$][\w$]*(?=\s*:)/y },
  { cls: "hljs-title", re: /[A-Za-z_$][\w$]*(?=\s*\()/y },
];

RULES.python = [
  { cls: "hljs-comment", first: "#", re: /#[^\n]*/y },
  { cls: "hljs-string", first: "\"'fFrRbBuU",
    re: /[a-zA-Z]{0,3}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/y },
  { cls: "hljs-meta", first: "@", re: /@[A-Za-z_][\w.]*/y },
  { cls: "hljs-number", first: "0123456789",
    re: /\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?j?)\b/y },
  { cls: "hljs-keyword",
    re: /\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|is|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|global|nonlocal|assert|del|yield|async|await|match|case)\b/y },
  { cls: "hljs-literal", re: /\b(?:True|False|None)\b/y },
  { cls: "hljs-built_in",
    re: /\b(?:self|cls|print|len|range|int|str|float|bool|list|dict|set|tuple|bytes|enumerate|zip|map|filter|sum|min|max|abs|round|sorted|reversed|open|type|isinstance|super|repr|input|format|ord|chr|any|all|divmod|pow|iter|next|getattr|setattr|hasattr|Exception|ValueError|TypeError|KeyError|IndexError|RuntimeError|StopIteration)\b/y },
  { cls: "hljs-type", re: /\b[A-Z][A-Za-z0-9_]*\b/y },
  { cls: "hljs-title", re: /[A-Za-z_]\w*(?=\s*\()/y },
];

RULES.css = [
  { cls: "hljs-comment", first: "/", re: /\/\*[\s\S]*?(?:\*\/|$)/y },
  { cls: "hljs-string", first: "\"'", re: /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y },
  { cls: "hljs-keyword", first: "@!", re: /@[\w-]+|!important/y },
  { cls: "hljs-number", first: "#", re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/y },
  { cls: "hljs-variable", first: "$", re: /\$[\w-]+/y },
  { cls: "hljs-attr", re: /[-\w]+(?=\s*:)/y },
  { cls: "hljs-title", first: ".#", re: /[.#][-\w]+/y },
  { cls: "hljs-selector-pseudo", first: ":", re: /:{1,2}[-\w]+(?:\([^)]*\))?/y },
  { cls: "hljs-built_in", re: /\b[-a-zA-Z_]+(?=\()/y },
  { cls: "hljs-number", first: "0123456789.", re: /(?:\d*\.\d+|\d+)(?:%|[a-zA-Z]+)?/y },
];

RULES.bash = [
  { cls: "hljs-meta", first: "#", re: /#!?[^\n]*/y },
  { cls: "hljs-string", first: "\"'`", re: /"(?:\\.|[^"\\\n])*"?|'(?:[^'\n])*'?|`(?:\\.|[^`\\\n])*`?/y },
  { cls: "hljs-variable", first: "$", re: /\$(?:\{[^}\n]*\}|[\w!?@*#-])/y },
  { cls: "hljs-keyword",
    re: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|select|time|return|exit|break|continue|export|local|declare|readonly|unset|source)\b/y },
  { cls: "hljs-built_in",
    re: /\b(?:echo|printf|cd|pwd|ls|cat|less|head|tail|grep|sed|awk|find|xargs|sort|uniq|wc|cp|mv|rm|mkdir|touch|chmod|chown|ln|tar|zip|unzip|curl|wget|npm|npx|node|python|python3|pip|pip3|git|docker|kubectl|ssh|scp|sudo|apt|brew|systemctl|journalctl|kill|ps|top|df|du|mount|env|date|open)\b/y },
  { cls: "hljs-params", first: "-", re: /--?[\w-]+/y,
    guard: (code, pos) => pos === 0 || /[\s;|&(]/.test(code[pos - 1]) },
  { cls: "hljs-number", first: "0123456789", re: /\b\d+(?:\.\d+)?\b/y },
];

RULES.json = [
  { cls: "hljs-comment", first: "/", re: /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
  { cls: "hljs-attr", first: "\"", re: /"(?:\\.|[^"\\])*"(?=\s*:)/y },
  { cls: "hljs-string", first: "\"", re: /"(?:\\.|[^"\\])*"?/y },
  { cls: "hljs-number", first: "-0123456789", re: /-?\b(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y },
  { cls: "hljs-literal", re: /\b(?:true|false|null)\b/y },
];

RULES.yaml = [
  { cls: "hljs-comment", first: "#", re: /#[^\n]*/y },
  { cls: "hljs-meta", first: "-.", re: /(?:^|\n)(?:---|\.\.\.)(?=\s|$)/my },
  { cls: "hljs-attr", re: /\w[\w.$-]*(?=\s*:(?:\s|$))/y },
  { cls: "hljs-string", first: "\"'", re: /"(?:\\.|[^"\\\n])*"?|'(?:[^'\n])*'?/y },
  { cls: "hljs-literal", re: /\b(?:true|false|null|yes|no|on|off|True|False|None)\b/y },
  { cls: "hljs-number", first: "-0123456789", re: /-?\b(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/y },
];

RULES.sql = [
  { cls: "hljs-comment", first: "-/", re: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y },
  { cls: "hljs-string", first: "\"'", re: /'(?:''|[^'])*'?|"(?:[^"\\]|\\.)*"?/y },
  { cls: "hljs-keyword",
    re: /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|RENAME|ADD|COLUMN|PRIMARY|KEY|FOREIGN|REFERENCES|UNIQUE|CONSTRAINT|DEFAULT|CHECK|INDEX|VIEW|TRIGGER|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|ON|USING|GROUP|ORDER|BY|HAVING|LIMIT|OFFSET|DISTINCT|AS|AND|OR|NOT|NULL|IS|IN|LIKE|ILIKE|BETWEEN|EXISTS|CASE|WHEN|THEN|ELSE|END|UNION|ALL|ANY|ASC|DESC|BEGIN|COMMIT|ROLLBACK|TRANSACTION|WITH|RETURNING|IF|CASCADE|AUTO_INCREMENT)\b/iy },
  { cls: "hljs-built_in",
    re: /\b(?:COUNT|SUM|AVG|MIN|MAX|COALESCE|NULLIF|CAST|CONCAT|SUBSTRING|LENGTH|UPPER|LOWER|TRIM|NOW|ROUND|ABS|GREATEST|LEAST)\b(?=\s*\()/iy },
  { cls: "hljs-number", first: "0123456789", re: /\b\d+(?:\.\d+)?\b/y },
];

RULES.clike = [
  { cls: "hljs-comment", first: "/", re: /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/y },
  { cls: "hljs-string", first: "\"'`", re: /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y },
  { cls: "hljs-meta", first: "#@", re: /(?:#[a-z_]+|@[A-Za-z][\w.]*)[^\n]*/y },
  { cls: "hljs-number", first: "0123456789",
    re: /\b(?:0[xX][\da-fA-F]+|\d[\d_]*\.?[\d_]*(?:[eE][+-]?\d+)?[fFlLuU]*)\b/y },
  { cls: "hljs-keyword",
    re: /\b(?:public|private|protected|static|final|const|var|let|void|int|long|short|double|float|bool|boolean|char|byte|unsigned|signed|struct|enum|union|class|interface|trait|impl|fn|func|package|import|using|namespace|new|delete|return|if|else|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|throws|extends|implements|abstract|virtual|override|sealed|async|await|yield|this|self|nullptr|nil|sizeof|typedef|template|typename|operator|extern|mut|pub|use|mod)\b/y },
  { cls: "hljs-literal", re: /\b(?:true|false|null|NULL|nil|None|undefined|Self)\b/y },
  { cls: "hljs-built_in",
    re: /\b(?:String|Integer|Double|Boolean|Object|Array|List|Map|Set|Vec|HashMap|Option|Result|Task|Promise|Exception|System|Console|printf|println|println!|fprintf|malloc|free|strlen)\b/y },
  { cls: "hljs-type", re: /\b[A-Z][A-Za-z0-9_]*\b/y },
  { cls: "hljs-title", re: /[A-Za-z_]\w*(?=\s*\()/y },
];

const RULES_PLAIN = [];

/* A tag is structure, not a word pattern, so markup gets its own walker. It
   descends into <script> and <style> so a generated page lights up the way an
   editor would, and it survives a reply that got cut off mid-tag. */
function tokenizeMarkup(code) {
  const out = [];
  const push = (cls, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[0] === cls) last[1] += text;
    else out.push([cls, text]);
  };
  let i = 0;
  while (i < code.length) {
    const lt = code.indexOf("<", i);
    if (lt < 0) { push("", code.slice(i)); break; }
    if (lt > i) push("", code.slice(i, lt));

    if (code.startsWith("<!--", lt)) {
      const end = code.indexOf("-->", lt + 4);
      const stop = end < 0 ? code.length : end + 3;
      push("hljs-comment", code.slice(lt, stop));
      i = stop;
      continue;
    }
    if (/^<![a-zA-Z]/.test(code.slice(lt))) {
      const end = code.indexOf(">", lt);
      const stop = end < 0 ? code.length : end + 1;
      push("hljs-meta", code.slice(lt, stop));
      i = stop;
      continue;
    }
    const open = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(code.slice(lt));
    if (!open) { push("", "<"); i = lt + 1; continue; }

    push("hljs-tag", open[1] ? "</" : "<");
    push("hljs-name", open[2]);
    const name = open[2].toLowerCase();
    let j = lt + open[0].length;
    let closedTag = false;
    while (j < code.length) {
      const c = code[j];
      if (c === '"' || c === "'") {
        let k = j + 1;
        while (k < code.length && code[k] !== c) k++;
        const stop = Math.min(k + 1, code.length);
        push("hljs-string", code.slice(j, stop));
        j = stop;
        continue;
      }
      if (c === ">") { push("hljs-tag", ">"); j++; closedTag = true; break; }
      if (/\s/.test(c)) { push("", c); j++; continue; }
      if (c === "=" || c === "/") { push("", c); j++; continue; }
      const attr = /^[^\s>"'=/]+/.exec(code.slice(j));
      if (!attr) { push("", c); j++; continue; }
      push("hljs-attr", attr[0]);
      j += attr[0].length;
    }
    i = j;

    if (!open[1] && closedTag && (name === "script" || name === "style")) {
      const close = new RegExp("</" + name + "\\s*>", "i").exec(code.slice(i));
      const bodyEnd = close ? i + close.index : code.length;
      const rules = name === "script" ? RULES.javascript : RULES.css;
      for (const t of scan(code.slice(i, bodyEnd), rules)) push(t[0], t[1]);
      i = bodyEnd;
    }
  }
  return out;
}

/* Fence info is free text ("```js", "```python3", "```html live"), so only the
   first word counts, and it is kept as written for the file name and the badge. */
const LANG_ALIAS = {
  js: "javascript", node: "javascript", nodejs: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "javascript", ts: "javascript", tsx: "javascript", typescript: "javascript",
  py: "python", python3: "python",
  htm: "markup", html: "markup", xml: "markup", xhtml: "markup", svg: "markup", vue: "markup",
  css: "css", scss: "css", sass: "css", less: "css",
  json: "json", json5: "json", jsonc: "json",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash", console: "bash", "shell-session": "bash",
  yaml: "yaml", yml: "yaml",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
  c: "clike", h: "clike", cpp: "clike", "c++": "clike", cs: "clike", csharp: "clike",
  java: "clike", kotlin: "clike", scala: "clike", go: "clike", golang: "clike",
  rust: "clike", php: "clike", ruby: "clike", swift: "clike", dart: "clike",
  text: "plain", txt: "plain", plaintext: "plain", plain: "plain", md: "plain", markdown: "plain",
};

const LANG_LABEL = {
  js: "JavaScript", javascript: "JavaScript", typescript: "TypeScript", ts: "TypeScript",
  jsx: "JSX", tsx: "TSX", node: "Node",
  python: "Python", py: "Python",
  html: "HTML", markup: "HTML", xml: "XML", svg: "SVG", vue: "Vue",
  css: "CSS", scss: "SCSS", less: "Less", json: "JSON", bash: "Shell", sh: "Shell",
  yaml: "YAML", yml: "YAML", sql: "SQL", c: "C", cpp: "C++", cs: "C#", java: "Java",
  kotlin: "Kotlin", go: "Go", rust: "Rust", php: "PHP", ruby: "Ruby", swift: "Swift",
  plain: "Text",
};

const LANG_EXT = {
  js: "js", javascript: "js", mjs: "js", cjs: "js", node: "js",
  ts: "ts", typescript: "ts", jsx: "jsx", tsx: "tsx",
  py: "py", python: "py", python3: "py",
  html: "html", htm: "html", markup: "html", xml: "xml", svg: "svg", vue: "vue",
  css: "css", scss: "scss", sass: "scss", less: "less",
  json: "json", yaml: "yaml", yml: "yaml",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh",
  sql: "sql", c: "c", h: "h", cpp: "cpp", "c++": "cpp", cs: "cs", java: "java",
  kotlin: "kt", go: "go", rust: "rs", php: "php", ruby: "rb", swift: "swift",
};

function langToken(info) {
  return String(info || "").trim().split(/[\s,:;][\s,:;]*/)[0].toLowerCase().replace(/[^a-z0-9+#.-]/g, "");
}

function langKind(info) {
  const token = langToken(info);
  return LANG_ALIAS[token] || (RULES[token] ? token : "plain");
}

function langLabel(info) {
  const token = langToken(info);
  if (!token) return "Code";
  return LANG_LABEL[token] || LANG_LABEL[LANG_ALIAS[token]] || token.toUpperCase();
}

function langExt(info) {
  const token = langToken(info);
  return LANG_EXT[token] || LANG_EXT[langKind(info)] || "txt";
}

/* Only a document or a loose script can actually render something. A bare CSS
   or Python block has nothing to show, so the Preview tab is not offered. */
function previewMode(info) {
  const kind = langKind(info);
  if (kind === "markup") return "document";
  if (kind === "javascript") return "script";
  return null;
}

function syntaxTokens(code, info) {
  const kind = langKind(info);
  if (kind === "plain") return [["", code]];
  if (kind === "markup") return tokenizeMarkup(code);
  const rules = RULES[kind] || RULES_PLAIN;
  return rules.length ? scan(code, rules) : [["", code]];
}

function syntaxNodes(code, info) {
  return syntaxTokens(code, info).map(([cls, text]) => {
    if (!cls) return document.createTextNode(text);
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  });
}

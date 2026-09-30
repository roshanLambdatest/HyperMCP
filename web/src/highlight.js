// Small YAML highlighter for the editor overlay: comments, keys, strings, numbers, booleans,
// ${{ .secrets.X }} references, $test-style variables and <set X> placeholders. Line-based and
// deliberately forgiving: it only colours, it never changes the text.

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function value(v) {
  if (!v) return "";
  // placeholders and secret references first: they're what the reader must act on
  return esc(v)
    .replace(/(&lt;set [^&]*&gt;)/g, '<span class="t-todo">$1</span>')
    .replace(/(\$\{\{[^}]*\}\})/g, '<span class="t-secret">$1</span>')
    .replace(/(^|[\s"'=:])(\$[A-Za-z_][\w]*|\$\{[^}]+\})/g, '$1<span class="t-var">$2</span>')
    .replace(/^(\s*)(true|false|null|yes|no)(\s*)$/i, '$1<span class="t-bool">$2</span>$3')
    .replace(/^(\s*)(-?\d+(?:\.\d+)?)(\s*)$/, '$1<span class="t-num">$2</span>$3')
    .replace(/^(\s*)(["'])(.*)\2(\s*)$/, '$1<span class="t-str">$2$3$2</span>$4');
}

function line(l) {
  if (/^\s*#/.test(l)) return `<span class="t-comment">${esc(l)}</span>`;
  if (/^---\s*$/.test(l)) return `<span class="t-comment">${esc(l)}</span>`;
  const m = l.match(/^(\s*)(- )?([\w.$/-]+)(:)(\s|$)(.*)$/);
  if (m) {
    const [, ind, dash = "", key, colon, sp, rest] = m;
    const hash = rest.match(/^(.*?)(\s+#.*)$/);
    const val = hash ? hash[1] : rest;
    return `${ind}${dash ? '<span class="t-dash">- </span>' : ""}<span class="t-key">${esc(key)}</span><span class="t-punct">${colon}</span>${sp}${value(val)}${hash ? `<span class="t-comment">${esc(hash[2])}</span>` : ""}`;
  }
  const li = l.match(/^(\s*)(- )(.*)$/);
  if (li) return `${li[1]}<span class="t-dash">- </span>${value(li[3])}`;
  return value(l);
}

// Always ends with a newline so the overlay is as tall as the textarea's last line.
export const highlightYaml = (text) => text.split("\n").map(line).join("\n") + "\n";

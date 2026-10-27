const MAGIC = [0x48, 0x55, 0x46, 0x31]; // "HUF1"
const $ = (s) => document.querySelector(s);
const fmt = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

/* ---------- Huffman core ---------- */

// Builds the tree from byte frequencies. Ties break on node id, so the
// same frequencies always produce the same tree (needed for decoding).
function buildTree(freq) {
  const L = [], R = [], S = [], list = [];
  for (let s = 0; s < 256; s++) {
    if (freq[s]) { list.push({ w: freq[s], id: S.length }); L.push(-1); R.push(-1); S.push(s); }
  }
  while (list.length > 1) {
    list.sort((a, b) => a.w - b.w || a.id - b.id);
    const [a, b] = list.splice(0, 2);
    L.push(a.id); R.push(b.id); S.push(-1);
    list.push({ w: a.w + b.w, id: L.length - 1 });
  }
  return { L: Int32Array.from(L), R: Int32Array.from(R), S: Int32Array.from(S), root: list[0].id };
}

function makeCodes(tree) {
  const codes = new Array(256);
  (function walk(n, path) {
    if (tree.S[n] >= 0) { codes[tree.S[n]] = path.length ? Uint8Array.from(path) : Uint8Array.of(0); return; }
    path.push(0); walk(tree.L[n], path);
    path[path.length - 1] = 1; walk(tree.R[n], path);
    path.pop();
  })(tree.root, []);
  return codes;
}

/* File layout: magic(4) | nameLen(2) | name | originalSize(4) | symbolCount(2) |
   [byte(1) + frequency(4)] x symbolCount | packed bits */
function compress(data, name) {
  const freq = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) freq[data[i]]++;
  const syms = [];
  for (let s = 0; s < 256; s++) if (freq[s]) syms.push(s);

  const nameBytes = new TextEncoder().encode(name).slice(0, 65535);
  const headerLen = 4 + 2 + nameBytes.length + 4 + 2 + syms.length * 5;

  let codes = null, bits = 0;
  if (syms.length) {
    codes = makeCodes(buildTree(freq));
    for (const s of syms) bits += freq[s] * codes[s].length;
  }

  const out = new Uint8Array(headerLen + Math.ceil(bits / 8));
  const dv = new DataView(out.buffer);
  let p = 0;
  out.set(MAGIC, p); p += 4;
  dv.setUint16(p, nameBytes.length); p += 2;
  out.set(nameBytes, p); p += nameBytes.length;
  dv.setUint32(p, data.length); p += 4;
  dv.setUint16(p, syms.length); p += 2;
  for (const s of syms) { out[p++] = s; dv.setUint32(p, freq[s]); p += 4; }

  let acc = 0, n = 0;
  for (let i = 0; i < data.length; i++) {
    const c = codes[data[i]];
    for (let j = 0; j < c.length; j++) {
      acc = (acc << 1) | c[j];
      if (++n === 8) { out[p++] = acc; acc = 0; n = 0; }
    }
  }
  if (n) out[p++] = acc << (8 - n);
  return out;
}

function decompress(bytes) {
  if (bytes.length < 12 || MAGIC.some((m, i) => bytes[i] !== m)) {
    throw new Error("This isn't a .huff file made by this tool.");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 4;
  const nameLen = dv.getUint16(p); p += 2;
  const name = new TextDecoder().decode(bytes.subarray(p, p + nameLen)); p += nameLen;
  const size = dv.getUint32(p); p += 4;
  const count = dv.getUint16(p); p += 2;
  if (count > 256 || p + count * 5 > bytes.length) throw new Error('The file header is damaged.');

  const freq = new Uint32Array(256);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const s = bytes[p++]; freq[s] = dv.getUint32(p); p += 4; total += freq[s];
  }
  if (total !== size) throw new Error('The file header is damaged.');

  const out = new Uint8Array(size);
  if (size) {
    const { L, R, S, root } = buildTree(freq);
    if (count === 1) {
      out.fill(S[root]);
    } else {
      let node = root, o = 0;
      for (; p < bytes.length && o < size; p++) {
        const b = bytes[p];
        for (let k = 7; k >= 0; k--) {
          node = (b >> k) & 1 ? R[node] : L[node];
          if (S[node] >= 0) { out[o++] = S[node]; node = root; if (o === size) break; }
        }
      }
      if (o < size) throw new Error('The file is incomplete or damaged.');
    }
  }
  return { data: out, name };
}

/* ---------- Interface ---------- */

let mode = 'compress';
let objectUrl = null;

function setMode(m) {
  mode = m;
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === m));
  const c = m === 'compress';
  $('#file').accept = c ? '.pdf,.docx,image/*' : '.huff';
  $('#file').value = '';
  $('#dropTitle').textContent = c ? 'Choose a file to compress' : 'Choose a .huff file to decompress';
  $('#dropHint').textContent = c ? 'or drop it here. PDF, DOCX, PNG, JPG, WebP.' : 'or drop it here.';
  $('#result').hidden = true;
  $('#error').hidden = true;
}

function showError(msg) {
  $('#result').hidden = true;
  $('#error').textContent = msg;
  $('#error').hidden = false;
}

function showResult(inName, outName, a, b, blob) {
  const c = mode === 'compress';
  $('#error').hidden = true;
  $('#result').hidden = false;
  $('#resName').textContent = c ? inName + '  to  ' + outName : inName + '  to  ' + outName;
  $('#labelA').textContent = c ? 'Original' : 'Compressed file';
  $('#labelB').textContent = c ? 'Compressed' : 'Restored file';
  $('#sizeA').textContent = fmt(a);
  $('#sizeB').textContent = fmt(b);
  const max = Math.max(a, b, 1);
  $('#barA').style.width = (a / max * 100) + '%';
  $('#barB').style.width = (b / max * 100) + '%';
  $('#barB').classList.toggle('worse', c && b > a);

  if (c) {
    const saved = a ? (1 - b / a) * 100 : 0;
    $('#summary').innerHTML = saved > 0
      ? 'Smaller by <b>' + saved.toFixed(1) + '%</b>.' + (saved < 5 ? ' This format is already compressed, so there is little left to remove.' : '')
      : 'The result is <b>' + Math.abs(saved).toFixed(1) + '% larger</b>. PDFs, DOCX files and JPG/PNG images are already compressed internally, so Huffman coding can\u2019t shrink them further.';
  } else {
    $('#summary').innerHTML = 'Restored the original file, byte for byte.';
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  $('#download').href = objectUrl;
  $('#download').download = outName;
}

async function handle(file) {
  if (!file) return;
  $('#error').hidden = true;
  $('#result').hidden = true;
  $('#dropTitle').textContent = 'Working on ' + file.name + '\u2026';
  await new Promise((r) => setTimeout(r, 30)); // let the message paint
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (mode === 'compress') {
      const out = compress(bytes, file.name);
      showResult(file.name, file.name + '.huff', bytes.length, out.length, new Blob([out]));
    } else {
      const { data, name } = decompress(bytes);
      showResult(file.name, name, bytes.length, data.length, new Blob([data]));
    }
  } catch (e) {
    showError(e.message || 'Something went wrong while reading the file.');
  }
  const c = mode === 'compress';
  $('#dropTitle').textContent = c ? 'Choose another file to compress' : 'Choose another .huff file';
  $('#file').value = '';
}

document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('#file').addEventListener('change', (e) => handle(e.target.files[0]));

const drop = $('#drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => handle(e.dataTransfer.files[0]));

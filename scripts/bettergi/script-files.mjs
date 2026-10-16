// LimitedFile port; BetterGI c9db8b8291fe4ac25a600aee1582298005919eb2, GPL-3.0.
import fs from 'node:fs';
import path from 'node:path';

const textExtensions = new Set(['.txt', '.json', '.log', '.csv', '.xml', '.html', '.css', '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp']);
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp']);
const within = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

export class ScriptFiles {
  constructor({ scriptRoot, stateRoot, allowedRoots = [], rpc, list = value => value, log = () => {} }) {
    this.root = fs.realpathSync(scriptRoot);
    this.roots = [this.root, ...allowedRoots.map(root => fs.realpathSync(root))];
    this.rpc = rpc; this.list = list; this.log = log;
    fs.mkdirSync(stateRoot, { recursive: true });
    this.stateRoot = fs.realpathSync(stateRoot);
    this.overlay = path.join(this.stateRoot, 'files');
    fs.mkdirSync(this.overlay, { recursive: true });
    this.deletedPath = path.join(this.stateRoot, 'renamed.json');
    this.deleted = new Set(fs.existsSync(this.deletedPath) ? JSON.parse(fs.readFileSync(this.deletedPath, 'utf8')) : []);
  }

  normalize(relative, base = this.root, writable = false) {
    if (typeof relative !== 'string' || !relative.trim() || relative.includes('\0')) throw new TypeError('Expected a nonempty relative script path');
    relative = relative.replaceAll('\\', '/');
    if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Absolute script paths are not allowed');
    const candidate = path.resolve(base, relative);
    if (!(writable ? [this.root] : this.roots).some(root => within(root, candidate))) throw new Error('Script path escapes installed resources: ' + relative);
    let existing = candidate;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('Script path has no existing parent');
      existing = parent;
    }
    const resolved = fs.realpathSync(existing);
    if (!(writable ? [this.root] : this.roots).some(root => within(root, resolved))) throw new Error('Script symlink escapes installed resources: ' + relative);
    return { source: candidate, relative: path.relative(this.root, candidate), primary: within(this.root, candidate) };
  }

  hidden(relative) { return [...this.deleted].some(item => relative === item || relative.startsWith(item + path.sep)); }
  overlayPath(relative) {
    const candidate = path.join(this.overlay, relative);
    let existing = candidate;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (!within(this.overlay, fs.realpathSync(existing))) throw new Error('Script state symlink escapes writable overlay');
    return candidate;
  }
  locate(relative) {
    const entry = this.normalize(relative);
    if (!entry.primary) return entry.source;
    const overlay = this.overlayPath(entry.relative);
    if (fs.existsSync(overlay)) return overlay;
    if (this.hidden(entry.relative)) return null;
    return entry.source;
  }
  stat(relative) { const filename = this.locate(relative); try { return filename ? fs.statSync(filename) : null; } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; } }
  isExists(relative) { return !!this.stat(relative); }
  isFile(relative) { return this.stat(relative)?.isFile() ?? false; }
  isFolder(relative) { return this.stat(relative)?.isDirectory() ?? false; }

  readTextSync(relative) {
    const filename = this.locate(relative);
    try { return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''); }
    catch (error) { this.log('error', 'ReadTextSync: ' + error.message); return ''; }
  }
  async readText(relative, callback) {
    const filename = this.locate(relative);
    try { const value = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''); callback?.(null, value); return value; }
    catch (error) { if (callback) callback(error.message, null); else this.log('error', 'ReadText: ' + error.message); return ''; }
  }
  readPathSync(relative) {
    const entry = this.normalize(relative);
    const byName = new Map();
    const readDirectory = filename => {
      if (!filename || !fs.existsSync(filename) || !fs.statSync(filename).isDirectory()) return;
      for (const item of fs.readdirSync(filename, { withFileTypes: true })) byName.set(item.name, item.isDirectory());
    };
    if (!entry.primary || !this.hidden(entry.relative)) readDirectory(entry.source);
    if (entry.primary) readDirectory(this.overlayPath(entry.relative));
    return this.list([...byName].filter(([name]) => !entry.primary || this.isExists(path.join(entry.relative, name)))
      .sort((a, b) => Number(a[1]) - Number(b[1]) || a[0].localeCompare(b[0]))
      .map(([name]) => path.join(entry.relative, name)));
  }
  createDirectory(relative) {
    const entry = this.normalize(relative, this.root, true);
    try { fs.mkdirSync(this.overlayPath(entry.relative), { recursive: true }); return true; }
    catch (error) { this.log('error', 'CreateDirectory: ' + error.message); return false; }
  }
  writeTarget(relative, content, image = false) {
    if (image && !imageExtensions.has(path.extname(relative).toLowerCase())) relative += '.png';
    const entry = this.normalize(relative, this.root, true);
    if (!(image ? imageExtensions : textExtensions).has(path.extname(relative).toLowerCase())) return null;
    if (content != null && (typeof content !== 'string' || content.length > 999 * 1024 * 1024)) return null;
    const target = this.overlayPath(entry.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return { ...entry, target };
  }
  writeTextSync(relative, content, append = false) {
    const entry = this.writeTarget(relative, content);
    if (!entry) return false;
    try {
      if (append && !fs.existsSync(entry.target) && this.isFile(relative)) fs.copyFileSync(this.locate(relative), entry.target);
      fs.writeFileSync(entry.target, content, { encoding: 'utf8', flag: append ? 'a' : 'w' });
      return true;
    } catch (error) { this.log('error', 'WriteTextSync: ' + error.message); return false; }
  }
  async writeText(relative, content, callbackOrAppend = false, append = false) {
    const callback = typeof callbackOrAppend === 'function' ? callbackOrAppend : null;
    const ok = this.writeTextSync(relative, content, callback ? append : callbackOrAppend);
    callback?.(ok ? null : 'Invalid path or file content', ok ? true : null);
    return ok;
  }
  readImageMatSync(relative) {
    const filename = this.locate(relative);
    try { if (!filename || !this.isFile(relative)) throw new Error('Image file does not exist: ' + relative); return this.rpc('image.load', { path: filename, type: 'Mat' }); }
    catch (error) { this.log('error', error.message); return this.rpc('image.mat', { method: 'New', args: [] }); }
  }
  readImageMatWithResizeSync(relative, width, height, interpolation = 1) {
    if (![width, height].every(value => Number.isFinite(value) && value > 0) || !Number.isInteger(interpolation) || interpolation < 0 || interpolation > 5) return this.rpc('image.mat', { method: 'New', args: [] });
    const image = this.readImageMatSync(relative);
    try { return this.rpc('image.mat', { handle: image.handle, method: 'Resize', args: [{ width, height }, 0, 0, interpolation] }); }
    finally { this.rpc('image.dispose', { handle: image.handle }); }
  }
  writeImageSync(relative, mat) {
    const entry = this.writeTarget(relative, null, true);
    if (!entry) return false;
    try { this.rpc('image.save', { path: entry.target, handle: mat.handle }); return true; }
    catch (error) { this.log('error', 'WriteImageSync: ' + error.message); return false; }
  }
  renamePathSync(oldPath, newPath) {
    const oldEntry = this.normalize(oldPath, this.root, true), newEntry = this.normalize(newPath, this.root, true);
    if (!this.isExists(oldPath) || this.isExists(newPath) || oldEntry.relative === '' || newEntry.relative.startsWith(oldEntry.relative + path.sep)) return false;
    if (this.isFile(oldPath) && !textExtensions.has(path.extname(newPath).toLowerCase())) return false;
    const copy = (sourceRelative, targetRelative) => {
      const destination = this.overlayPath(targetRelative);
      if (this.isFolder(sourceRelative)) {
        fs.mkdirSync(destination, { recursive: true });
        for (const child of this.readPathSync(sourceRelative)) copy(child, path.join(targetRelative, path.basename(child)));
      } else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(this.locate(sourceRelative), destination); }
    };
    try {
      copy(oldEntry.relative, newEntry.relative);
      fs.rmSync(this.overlayPath(oldEntry.relative), { recursive: true, force: true });
      this.deleted.add(oldEntry.relative);
      fs.writeFileSync(this.deletedPath, JSON.stringify([...this.deleted]));
      return true;
    } catch (error) { this.log('error', 'RenamePathSync: ' + error.message); return false; }
  }
}

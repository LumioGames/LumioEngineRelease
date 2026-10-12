#!/usr/bin/env node
// 引擎发布物自检(ADR-123「失败语义」)。随发布物进 tools/,游戏仓的更新命令与启动器都调用它;
// 校验实现只此一份,不得在游戏仓另写一套。只用 Node 内置模块:发布物里没有别的依赖可 import。
//
//   node tools/verify-release.mjs [--root <发布物根>] [--rid <rid>] [--version <x.y.z>] [--json]
//
// 退出码:0 通过;1 = sdk_version_mismatch(manifest 与实际文件不符);2 = BLOCKED_ENV
// (发布物不在 / 当前平台不在 manifest 里)。不新增公共错误码。
//
// 不算发布物内容、校验时跳过的只有两类(repository-architecture「引擎发布物」):
//   - 发布仓的仓库元数据,只在根目录:`.git`(子模块里是文件)与发布工作流写入的 `.gitattributes`
//     (`* -text`,让 Windows 默认 autocrlf 的检出也逐字节等于 manifest)。
//   - 操作系统在任意目录自动生成的三个固定名字:`.DS_Store`、`Thumbs.db`、`desktop.ini`。
// 其余多出来的文件一律算被改过的发布物。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const MISMATCH = 'sdk_version_mismatch';
export const BLOCKED = 'BLOCKED_ENV';
export const MANIFEST_FILE = 'manifest.json';
export const SDK_PACKAGE_ID = 'Lumio.Engine.SDK';
const FORMAT_VERSIONS = [1, 2];
const SOURCE_COUNT = 7;
const RID = /^(?:win|linux|osx)-(?:x64|arm64)$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/;
export const REPOSITORY_METADATA = Object.freeze(['.git', '.gitattributes']);
export const SYSTEM_JUNK = Object.freeze(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * 发布物里要带可执行位的文件(相对发布物根)。Windows 平台没有这一位;Bot 宿主是框架依赖的
 * `dotnet <dll>`、tools/ 由 node 运行,都不需要。组装(pack-release)按它恢复权限,校验按它检查,
 * 两边只此一份清单。
 */
export function releaseExecutables(rid) {
  return rid.startsWith('win-') ? [] : [`server/${rid}/lumio-ds`];
}

function failure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

const mismatch = message => failure(MISMATCH, message);
const blocked = message => failure(BLOCKED, message);

export function hostRid(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win', linux: 'linux', darwin: 'osx' }[platform];
  if (!os) throw blocked(`no release RID for platform=${platform} arch=${arch}`);
  return `${os}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function listFiles(root) {
  const out = [];
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && REPOSITORY_METADATA.includes(name)) continue;
      if (SYSTEM_JUNK.includes(name)) continue;
      const path = join(directory, name);
      assertContained(root, path);
      if (lstatSync(path).isSymbolicLink() && statSync(path).isDirectory()) throw mismatch(`directory symlink is not allowed in release: ${relative(root, path)}`);
      if (statSync(path).isDirectory()) visit(path);
      else out.push(relative(root, path).split(sep).join('/'));
    }
  };
  visit(root);
  return out;
}

// 只读 nupkg 里两份元数据:根目录的 .nuspec 与 content/sdk-version.json。最小 ZIP 读取,
// 只支持 NuGet 实际使用的 stored / deflate 两种方法。
function readZipEntries(path) {
  const bytes = readFileSync(path);
  const invalid = detail => mismatch(`${relative(process.cwd(), path) || path} is not a readable nupkg (${detail})`);
  if (bytes.length < 22) throw invalid('shorter than an end-of-central-directory record');
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 0xffff); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw invalid('end-of-central-directory record missing');
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalid(`central-directory entry ${index} truncated`);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw invalid(`local header missing for ${name}`);
      const start = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) return Buffer.from(data).toString('utf8');
      if (method === 8) return inflateRawSync(data).toString('utf8');
      throw invalid(`unsupported compression method ${method} for ${name}`);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readPackageVersions(nupkgPath) {
  const entries = readZipEntries(nupkgPath);
  const nuspecName = [...entries.keys()].find(name => !name.includes('/') && name.toLowerCase().endsWith('.nuspec'));
  if (!nuspecName) throw mismatch(`${nupkgPath} has no .nuspec`);
  const nuspec = entries.get(nuspecName)();
  const id = /<id>([^<]+)<\/id>/.exec(nuspec)?.[1]?.trim();
  const version = /<version>([^<]+)<\/version>/.exec(nuspec)?.[1]?.trim();
  const metadataEntry = entries.get('content/sdk-version.json');
  if (!metadataEntry) throw mismatch(`${nupkgPath} has no content/sdk-version.json`);
  let metadata;
  try {
    metadata = JSON.parse(metadataEntry());
  } catch (error) {
    throw mismatch(`${nupkgPath} content/sdk-version.json is not valid JSON (${error.message})`);
  }
  return { id, version, metadataVersion: metadata.version };
}

export function readManifest(root) {
  const path = join(root, MANIFEST_FILE);
  if (!existsSync(path)) {
    // 子模块没拉时 Engine/ 是空目录:这是环境问题,不是发布物坏了。
    throw blocked(`${MANIFEST_FILE} not found under ${root}; the engine release is not present (for a game repository: git submodule update --init --depth 1 Engine)`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw mismatch(`${MANIFEST_FILE} is not valid JSON (${error.message})`);
  }
  const problems = [];
  if (!FORMAT_VERSIONS.includes(manifest?.formatVersion)) problems.push(`formatVersion must be 1 or 2`);
  if (typeof manifest?.version !== 'string' || !SEMVER.test(manifest.version)) problems.push('version must be a semantic version');
  if (!Array.isArray(manifest?.platforms) || manifest.platforms.length === 0
    || manifest.platforms.some(rid => typeof rid !== 'string' || !RID.test(rid))
    || new Set(manifest.platforms).size !== manifest.platforms.length) problems.push('platforms must be a non-empty list of distinct RIDs');
  const sources = manifest?.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources) || Object.keys(sources).length !== SOURCE_COUNT
    || Object.values(sources).some(commit => typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit))) {
    problems.push(`sources must record ${SOURCE_COUNT} repositories, each with a 40-hex commit`);
  }
  // 回归形态(版本带预发布段,如 0.0.1-main.<sha>)在没有 Docker 的机器上编不出 Platform 镜像,
  // platformImage 如实为 null、不带 platform/;正式版本必须有镜像引用。
  const regressionWithoutPlatform = manifest?.platformImage === null && typeof manifest?.version === 'string' && manifest.version.includes('-');
  if (!regressionWithoutPlatform && (typeof manifest?.platformImage !== 'string' || !/^\S+@sha256:[0-9a-f]{64}$/.test(manifest.platformImage))) {
    problems.push('platformImage must be <image>:<tag>@sha256:<digest>');
  }
  if (!manifest?.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
    || Object.values(manifest.files).some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
    problems.push('files must map relative paths to sha256');
  }
  if (manifest?.files && Object.keys(manifest.files).some(path => !safeRelativePath(path))) problems.push('files contain an unsafe relative path');
  if (problems.length > 0) throw mismatch(`${MANIFEST_FILE} is malformed: ${problems.join('; ')}`);
  return manifest;
}

/**
 * 校验一份发布物。rid 缺省为本进程的 RID;expectedVersion 给了就必须与 manifest 相同。
 * checkModes 缺省在非 Windows 上为真:检查 releaseExecutables 的 x 位。
 * 返回 { version, platforms, rid, files }。不符时抛出 code = sdk_version_mismatch / BLOCKED_ENV 的错误。
 */
export function verifyRelease({ root, rid = hostRid(), expectedVersion, checkModes = process.platform !== 'win32' } = {}) {
  if (!root) throw blocked('release root is required (--root)');
  root = resolve(root);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw blocked(`release root ${root} does not exist`);
  const manifest = readManifest(root);
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw mismatch(`manifest version ${manifest.version} differs from the requested ${expectedVersion}`);
  }

  // 每个文件的 sha256:manifest 列了的必须在且一致,磁盘上多出来的也算不符(被改过的发布物)。
  const onDisk = listFiles(root).filter(path => path !== MANIFEST_FILE);
  const listed = Object.keys(manifest.files);
  const missing = listed.filter(path => !onDisk.includes(path));
  const extra = onDisk.filter(path => !(path in manifest.files));
  const changed = listed.filter(path => onDisk.includes(path) && sha256File(join(root, path)) !== manifest.files[path]);
  if (missing.length || extra.length || changed.length) {
    throw mismatch([
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `not in manifest: ${extra.join(', ')}` : '',
      changed.length ? `sha256 differs: ${changed.join(', ')}` : '',
    ].filter(Boolean).join('; '));
  }

  // SDK 包:恰好一个,文件名、nuspec 与包内 sdk-version.json 三处版本都等于 manifest.version。
  const packages = onDisk.filter(path => path.startsWith('sdk/') && path.endsWith('.nupkg'));
  const expectedPackage = `sdk/${SDK_PACKAGE_ID}.${manifest.version}.nupkg`;
  if (packages.length !== 1 || packages[0] !== expectedPackage) {
    throw mismatch(`expected exactly ${expectedPackage}; found ${packages.length ? packages.join(', ') : 'no SDK package'}`);
  }
  const packaged = readPackageVersions(join(root, expectedPackage));
  if (packaged.id !== SDK_PACKAGE_ID || packaged.version !== manifest.version || packaged.metadataVersion !== manifest.version) {
    throw mismatch(`SDK package declares id=${packaged.id} version=${packaged.version} (sdk-version.json ${packaged.metadataVersion}); manifest version is ${manifest.version}`);
  }

  // 平台:manifest 列的每一档都要有 server/ 与 bot/;没列的不得出现(不拿别的平台凑)。
  const present = new Set(onDisk.filter(path => /^(?:server|bot)\/[^/]+\//.test(path)).map(path => path.split('/').slice(0, 2).join('/')));
  for (const platform of manifest.platforms) {
    for (const kind of ['server', 'bot']) {
      if (!present.has(`${kind}/${platform}`)) throw mismatch(`manifest lists ${platform} but ${kind}/${platform}/ is missing`);
    }
  }
  const unlisted = [...present].filter(path => !manifest.platforms.includes(path.split('/')[1]));
  if (unlisted.length) throw mismatch(`release carries platforms the manifest does not list: ${unlisted.join(', ')}`);
  if (rid !== null && !manifest.platforms.includes(rid)) {
    throw blocked(`this engine release (${manifest.version}) has no ${rid} build; it carries ${manifest.platforms.join(', ')}. No fallback to another platform.`);
  }

  // 可执行位:Windows 上没有这一位可查;其余平台上,manifest 列的每个非 Windows 平台的可执行文件都必须
  // 带 x 位(git 按 100755 记录的就是属主 x 位)。经 CI artifact 中转丢了权限的发布物在这里拦下。
  if (checkModes) {
    const notExecutable = manifest.platforms.flatMap(releaseExecutables)
      .filter(path => onDisk.includes(path) && (statSync(join(root, path)).mode & 0o100) === 0);
    if (notExecutable.length) throw mismatch(`not executable (mode lacks the x bit): ${notExecutable.join(', ')}`);
  }
  const authoring = manifest.formatVersion === 2 ? verifyAuthoring({ root, manifest, checkModes }) : undefined;
  return { ...(authoring ? { authoring } : {}), version: manifest.version, platforms: manifest.platforms, rid, files: listed.length, platformImage: manifest.platformImage };
}


const AUTHOR_TOOLS = { 'capture-voxel': 'capture', 'config-compiler': 'config' };
const AUTHOR_RIDS = ['win-x64', 'linux-x64'];
const SOURCE_KEYS = ['GameEngine', 'NativeCore', 'VoxelEngine', 'GameRuntime', 'Server', 'Client', 'Platform'].map(suffix => 'Lumio' + suffix);
const fullCommit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const fullHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function safeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\x00]/.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function assertContained(root, path) {
  const actual = realpathSync(path);
  const rel = relative(realpathSync(root), actual);
  if (rel === '..' || rel.startsWith('..' + sep) || resolve(realpathSync(root), rel) !== actual) throw mismatch(`path escapes closure: ${path}`);
}
// Internal file links are permitted, but no links to a build host or cyclic directories.
export function authoringFiles(root) {
  const files = [];
  const visit = (directory, ancestors) => {
    assertContained(root, directory);
    const real = realpathSync(directory);
    if (ancestors.has(real)) throw mismatch(`cyclic authoring path: ${directory}`);
    const parents = new Set([...ancestors, real]);
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      assertContained(root, path);
      const info = statSync(path);
      if (info.isDirectory()) visit(path, parents);
      else if (info.isFile()) files.push(relative(root, path).split(sep).join('/'));
      else throw mismatch(`authoring path is not a regular file: ${path}`);
    }
  };
  visit(root, new Set());
  return files;
}
export function verifyAuthoringTool({ root, tool, rid, sourceCommit, providers, checkModes = process.platform !== 'win32' }) {
  const invalid = message => { throw mismatch(`${tool}/${rid}: ${message}`); };
  if (!AUTHOR_RIDS.includes(rid) || !Object.hasOwn(AUTHOR_TOOLS, tool)) invalid('unsupported tool or rid');
  const path = join(root, 'authoring-tool.json');
  if (!existsSync(path)) invalid('missing authoring-tool.json');
  assertContained(root, path);
  let metadata;
  try { metadata = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { invalid(`metadata is not JSON: ${error.message}`); }
  const entrypoint = tool + (rid.startsWith('win-') ? '.exe' : '');
  if (metadata.formatVersion !== 1 || metadata.tool !== tool || metadata.rid !== rid || metadata.entrypoint !== entrypoint) invalid('formatVersion/tool/rid/entrypoint differs');
  if (typeof metadata.version !== 'string' || !SEMVER.test(metadata.version)) invalid('version is not exact semver');
  if (!fullCommit(sourceCommit) || metadata.sourceCommit !== sourceCommit) invalid('sourceCommit differs from the fixed source');
  if (!record(metadata.runtime) || typeof metadata.runtime.version !== 'string' || !metadata.runtime.version) invalid('runtime version is missing');
  if (tool === 'config-compiler') {
    if (metadata.runtime.name !== 'python' || metadata.runtime.version !== '3.11.9'
      || metadata.packager?.name !== 'pyinstaller' || metadata.packager.version !== '6.11.1') invalid('runtime/packager must pin python 3.11.9 and pyinstaller 6.11.1');
    if (!fullHash(metadata.compilerHash)) invalid('compilerHash is missing');
  } else {
    const target = rid === 'win-x64' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-musl';
    if (metadata.runtime.name !== 'native' || metadata.toolchain?.name !== 'rust' || metadata.toolchain.version !== '1.98.0' || metadata.toolchain.target !== target || !fullHash(metadata.toolchain.dependencyLockSha256) || metadata.toolchain.staticCrt !== true || metadata.runtime.static !== true) invalid('toolchain/runtime does not match the actual rid target');
    if (!record(metadata.providers) || Object.keys(metadata.providers).length !== 2
      || ['nativeCore', 'voxelEngine'].some(key => !fullCommit(providers?.[key]) || metadata.providers[key] !== providers[key])) invalid('providers differ from the fixed sources');
  }
  if (!Array.isArray(metadata.dependencies) || !metadata.dependencies.length
    || metadata.dependencies.some(dep => !record(dep) || typeof dep.name !== 'string' || !dep.name || typeof dep.version !== 'string' || !dep.version || /^[<>=~^]|[*]/.test(dep.version))
    || new Set(metadata.dependencies.map(dep => `${dep.name}@${dep.version}`)).size !== metadata.dependencies.length) invalid('dependencies must record distinct exact versions');
  if (!record(metadata.files) || !Object.keys(metadata.files).length || Object.entries(metadata.files).some(([file, hash]) => !safeRelativePath(file) || !fullHash(hash) || file === 'authoring-tool.json' || /\.py$/i.test(file))) invalid('files must contain safe paths and sha256 for the compiled closure');
  if (!Object.hasOwn(metadata.files, entrypoint)) invalid('entrypoint is absent from files');
  if (!Array.isArray(metadata.licenses) || !metadata.licenses.length
    || new Set(metadata.licenses).size !== metadata.licenses.length
    || metadata.licenses.some(file => !safeRelativePath(file) || !Object.hasOwn(metadata.files, file))) invalid('licenses must be non-empty hashed closure files');
  const disk = authoringFiles(root).filter(file => file !== 'authoring-tool.json');
  const listed = Object.keys(metadata.files);
  const missing = listed.filter(file => !disk.includes(file));
  const extra = disk.filter(file => !Object.hasOwn(metadata.files, file));
  const changed = listed.filter(file => disk.includes(file) && sha256File(join(root, file)) !== metadata.files[file]);
  if (missing.length || extra.length || changed.length) invalid(`closure missing: ${missing.join(', ')}; extra: ${extra.join(', ')}; sha256 differs: ${changed.join(', ')}`);
  if (metadata.licenses.some(file => statSync(join(root, file)).size === 0)) invalid('license text is empty');
  if (checkModes && !rid.startsWith('win-') && !(statSync(join(root, entrypoint)).mode & 0o100)) invalid('entrypoint is not executable');
  return metadata;
}
export function verifyAuthoring({ root, manifest, checkModes = process.platform !== 'win32' }) {
  const a = manifest.authoring;
  if (!record(a) || a.formatVersion !== 1 || !fullCommit(a.configSourceCommit) || !record(a.tools)) throw mismatch('format 2 authoring identity is missing');
  if (Object.keys(manifest.sources).length !== SOURCE_KEYS.length || SOURCE_KEYS.some(key => !fullCommit(manifest.sources[key]))) throw mismatch('format 2 sources keys do not match the seven fixed sources');
  if (Object.keys(a.tools).length !== 2 || Object.keys(AUTHOR_TOOLS).some(tool => !record(a.tools[tool]))) throw mismatch('authoring.tools must contain capture-voxel and config-compiler');
  if (manifest.platforms.some(rid => !AUTHOR_RIDS.includes(rid))) throw mismatch('format 2 authoring supports win-x64 and linux-x64 only');
  const expectedFiles = new Set();
  for (const [tool, directory] of Object.entries(AUTHOR_TOOLS)) {
    for (const rid of manifest.platforms) if (!Object.hasOwn(a.tools[tool], rid)) throw mismatch(`${tool}/${rid} authoring tool is missing`);
    if (Object.keys(a.tools[tool]).length !== manifest.platforms.length) throw mismatch(`${tool} authoring rids differ from platforms`);
    for (const rid of manifest.platforms) {
      const ref = a.tools[tool][rid];
      const dir = `tools/authoring/${rid}/${directory}`;
      const metadataPath = `${dir}/authoring-tool.json`;
      const entrypoint = `${dir}/${tool}${rid.startsWith('win-') ? '.exe' : ''}`;
      if (!record(ref) || ref.metadata !== metadataPath || ref.entrypoint !== entrypoint || !fullHash(ref.sha256)
        || manifest.files[metadataPath] !== ref.sha256) throw mismatch(`${tool}/${rid} authoring metadata path/hash/entrypoint differs`);
      const metadata = verifyAuthoringTool({ root: join(root, dir), tool, rid,
        sourceCommit: tool === 'config-compiler' ? a.configSourceCommit : manifest.sources[SOURCE_KEYS[0]],
        providers: { nativeCore: manifest.sources[SOURCE_KEYS[1]], voxelEngine: manifest.sources[SOURCE_KEYS[2]] }, checkModes });
      for (const file of [...Object.keys(metadata.files), 'authoring-tool.json']) {
        expectedFiles.add(`${dir}/${file}`);
        if (manifest.files[`${dir}/${file}`] !== (file === 'authoring-tool.json' ? ref.sha256 : metadata.files[file])) throw mismatch(`${tool}/${rid} manifest.files differs for ${file}`);
      }
    }
  }
  const extra = Object.keys(manifest.files).filter(file => file.startsWith('tools/authoring/') && !expectedFiles.has(file));
  if (extra.length) throw mismatch(`extra authoring files: ${extra.join(', ')}`);
  return a;
}

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--json') { args.json = true; continue; }
    if (!['--root', '--rid', '--version'].includes(key) || !argv[index + 1]) {
      throw blocked('usage: node verify-release.mjs [--root <release root>] [--rid <rid>|any] [--version <x.y.z>] [--json]');
    }
    args[key.slice(2)] = argv[++index];
  }
  return args;
}

// Standalone by contract (tools/ in the release imports only Node built-ins):
// the realpath comparison is inlined rather than shared with entry-guard.mjs.
const isCliEntry = () => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (isCliEntry()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = verifyRelease({
      // 默认:脚本在 <发布物>/tools/ 下,发布物根是上一级。
      root: args.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      rid: args.rid === 'any' ? null : (args.rid ?? hostRid()),
      expectedVersion: args.version,
    });
    process.stdout.write(args.json
      ? `${JSON.stringify(result)}\n`
      : `PASS: engine release ${result.version} (${result.platforms.join(', ')}), ${result.files} files verified${result.rid ? ` for ${result.rid}` : ''}\n`);
  } catch (error) {
    const code = error.code === MISMATCH ? MISMATCH : BLOCKED;
    const message = error.code === MISMATCH || error.code === BLOCKED ? error.message : `${BLOCKED}: ${error.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = code === MISMATCH ? 1 : 2;
  }
}

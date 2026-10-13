import { Context, Session } from 'koishi'
import { readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, extname } from 'path'
import { fileURLToPath } from 'url'
import { DifyClient } from '../api/client'
import { DifyInputFileObject } from '../api/types'

type DifyFileType = DifyInputFileObject['type']

const MB = 1024 * 1024

/** Dify 各类文件的默认大小上限，与 Dify Cloud 默认一致 */
const SIZE_LIMITS: Record<DifyFileType, number> = {
  image: 10 * MB,
  audio: 50 * MB,
  video: 100 * MB,
  document: 15 * MB,
  custom: 15 * MB
}

/** 远程文件下载超时（与请求级 requestTimeout 独立，下载只服务于单文件） */
const REMOTE_FETCH_TIMEOUT_MS = 60_000

/** 元素类型到 Dify 文件类型的直判（mime 未知时的兜底） */
const ELEMENT_TYPE: Record<string, DifyFileType> = {
  img: 'image',
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'custom'
}

export interface FileCandidate {
  source: string
  type: DifyFileType
}

interface FilePayload {
  buffer: Buffer
  fileName: string
  mimeType: string
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
}

function guessMime(extension?: string): string {
  if (!extension) return 'application/octet-stream'
  return EXT_MIME[extension.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream'
}

function guessExtension(mimeType: string): string {
  const found = Object.entries(EXT_MIME).find(([, mime]) => mime === mimeType)
  return found ? found[0] : 'bin'
}

/** mime → Dify 文件类型 */
export function mimeToFileType(mimeType?: string): DifyFileType {
  if (!mimeType) return 'custom'
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/pdf' ||
    mimeType.includes('word') ||
    mimeType.includes('excel') ||
    mimeType.includes('spreadsheet')
  ) {
    return 'document'
  }
  return 'custom'
}

/** 从消息元素中提取可上传的文件候选（图片/语音/视频/附件），按来源去重 */
export function extractFileCandidates(session: Session): FileCandidate[] {
  const candidates: FileCandidate[] = []
  const seen = new Set<string>()
  for (const element of session.elements ?? []) {
    const difyType = ELEMENT_TYPE[element.type]
    if (!difyType) continue
    const source = element.attrs?.['url'] ?? element.attrs?.['src']
    if (typeof source !== 'string' || !source) continue
    const key = `${difyType}:${source}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ source, type: difyType })
  }
  return candidates
}

/** percent 解码到字节流（decodeURIComponent 走 UTF-16 会破坏非 ASCII 的原始字节） */
function percentDecodeBytes(input: string): Buffer {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '%' && /^[0-9a-fA-F]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(char.charCodeAt(0) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/** data URL 解析：base64 与 URL 编码两种形态 */
function parseDataUrl(source: string): FilePayload | null {
  const match = source.match(/^data:([^;,]*)((?:;[^;,]*)*)?,(.+)$/)
  if (!match) return null
  const mimeType = match[1] || 'application/octet-stream'
  const isBase64 = /(?:^|;)base64/.test(match[2] ?? '')
  const buffer = isBase64 ? Buffer.from(match[3], 'base64') : percentDecodeBytes(match[3])
  return { buffer, fileName: `file.${guessExtension(mimeType)}`, mimeType }
}

async function readLocalFile(ctx: Context, source: string): Promise<FilePayload | null> {
  const filePath = source.startsWith('file://') ? fileURLToPath(source) : source
  if (!existsSync(filePath)) {
    ctx.logger.warn('文件不存在，跳过上传：%s', filePath)
    return null
  }
  const buffer = await readFile(filePath)
  const mimeType = guessMime(extname(filePath))
  return { buffer, fileName: basename(filePath) || `file.${guessExtension(mimeType)}`, mimeType }
}

async function fetchRemoteFile(ctx: Context, source: string): Promise<FilePayload | null> {
  try {
    // 该重载直接返回 ArrayBuffer（非 2xx 由 cordis 默认 validateStatus 抛错进 catch）
    const data = await ctx.http.get(source, {
      responseType: 'arraybuffer',
      timeout: REMOTE_FETCH_TIMEOUT_MS
    })
    const buffer = Buffer.from(data)
    let fileName = ''
    try {
      fileName = decodeURIComponent(basename(new URL(source).pathname))
    } catch {}
    const mimeType = guessMime(extname(fileName))
    return { buffer, fileName: fileName || `file.${guessExtension(mimeType)}`, mimeType }
  } catch (error) {
    ctx.logger.warn('下载远程文件失败：%s (%s)', source, error)
    return null
  }
}

/** 三源归一：data URL / 远程 URL / 本地路径 → {buffer, fileName, mimeType}（冒烟测试直测） */
export async function resolveFilePayload(ctx: Context, candidate: FileCandidate): Promise<FilePayload | null> {
  const { source } = candidate
  if (source.startsWith('data:')) return parseDataUrl(source)
  if (/^https?:\/\//i.test(source)) return fetchRemoteFile(ctx, source)
  return readLocalFile(ctx, source)
}

/** 最终文件类型：mime 判定；元素已明确类型（如 img）而 mime 未知时沿用元素判定 */
function resolveFileType(mimeType: string | undefined, elementType: DifyFileType): DifyFileType {
  const mime = mimeToFileType(mimeType)
  return mime === 'custom' && elementType !== 'custom' ? elementType : mime
}

/** 上传数量与单文件大小限制（0 不限；大小与 Dify 各类型上限取较小值） */
export interface UploadLimit {
  maxCount: number
  maxSizeMb: number
}

/** 上传单个候选；失败/超限只记日志返回 null，不影响整体 */
async function uploadOne(
  ctx: Context,
  client: DifyClient,
  candidate: FileCandidate,
  difyUser: string,
  limit: UploadLimit
): Promise<DifyInputFileObject | null> {
  try {
    const payload = await resolveFilePayload(ctx, candidate)
    if (!payload) return null
    const type = resolveFileType(payload.mimeType, candidate.type)
    const maxBytes = limit.maxSizeMb > 0 ? limit.maxSizeMb * MB : Infinity
    const sizeLimit = Math.min(SIZE_LIMITS[type], maxBytes)
    if (payload.buffer.length > sizeLimit) {
      ctx.logger.warn(
        '文件 %s (%dMB) 超过上限 %dMB，跳过',
        payload.fileName,
        Math.round(payload.buffer.length / MB),
        Math.round(sizeLimit / MB)
      )
      return null
    }
    const uploaded = await client.uploadFile(
      { data: payload.buffer, filename: payload.fileName, mime: payload.mimeType },
      difyUser
    )
    return { type, transfer_method: 'local_file', upload_file_id: uploaded.id }
  } catch (error) {
    ctx.logger.warn('上传文件失败（%s）：%s', candidate.source, error)
    return null
  }
}

/** 一次上传的产物：成功的 files 载荷 + 被丢弃候选的来源 URL（截断/超限/失败统一记录，供占位符注记） */
export interface UploadResult {
  files: DifyInputFileObject[]
  dropped: string[]
}

/** 上传一批候选（入口按 type:source 去重，再按数量上限截断、逐个上传） */
export async function uploadCandidates(
  ctx: Context,
  client: DifyClient,
  candidates: FileCandidate[],
  difyUser: string,
  limit: UploadLimit
): Promise<UploadResult> {
  // 消息元素提取与窗口条目 URL 合流的候选可能有同图重复，统一在此去重；
  // 同一 URL 即同一文件（同 URL 双元素类型不重复上传），先到先得保留首个候选的类型
  const seen = new Set<string>()
  const unique = candidates.filter((candidate) => {
    if (seen.has(candidate.source)) return false
    seen.add(candidate.source)
    return true
  })
  const limited = limit.maxCount > 0 ? unique.slice(0, limit.maxCount) : unique
  // 同一 URL 可能以不同元素类型出现（去重键含类型拦不住），入列查重防占位符双重注记
  const dropped: string[] = []
  const markDropped = (source: string) => {
    if (!dropped.includes(source)) dropped.push(source)
  }
  unique.slice(limited.length).forEach((candidate) => markDropped(candidate.source))
  const files: DifyInputFileObject[] = []
  for (const candidate of limited) {
    const uploaded = await uploadOne(ctx, client, candidate, difyUser, limit)
    if (uploaded) files.push(uploaded)
    else markDropped(candidate.source)
  }
  return { files, dropped }
}

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

function parseDataUrl(source: string): FilePayload | null {
  const match = source.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return null
  const mimeType = match[1]
  const buffer = Buffer.from(match[2], 'base64')
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

/** 上传单个候选；失败/超限只记日志返回 null，不影响整体 */
async function uploadOne(
  ctx: Context,
  client: DifyClient,
  candidate: FileCandidate,
  difyUser: string
): Promise<DifyInputFileObject | null> {
  try {
    const payload = await resolveFilePayload(ctx, candidate)
    if (!payload) return null
    const type = resolveFileType(payload.mimeType, candidate.type)
    const limit = SIZE_LIMITS[type]
    if (payload.buffer.length > limit) {
      ctx.logger.warn(
        '文件 %s (%dMB) 超过 %s 类型上限 %dMB，跳过',
        payload.fileName,
        Math.round(payload.buffer.length / MB),
        type,
        Math.round(limit / MB)
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

/** 提取并上传消息中的文件，返回可附加到请求体的 files 数组 */
export async function uploadMessageFiles(
  ctx: Context,
  client: DifyClient,
  session: Session,
  difyUser: string
): Promise<DifyInputFileObject[]> {
  const candidates = extractFileCandidates(session)
  const files: DifyInputFileObject[] = []
  for (const candidate of candidates) {
    const uploaded = await uploadOne(ctx, client, candidate, difyUser)
    if (uploaded) files.push(uploaded)
  }
  return files
}

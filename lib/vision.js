/**
 * dsh-mobilecode — native multimodal delivery.
 *
 * When the routed model declares image input, the capture tools hand the model
 * the screenshot ITSELF (a `{type:'image', attachment}` block) instead of only a
 * file path it would have to open. DSH 0.1.1 carries images end to end: tool
 * results may contain image blocks, bytes live in the durable attachment store
 * (`ctx.get('attachments')`), and `llm.resolveModelInfo(...).inputModalities`
 * says whether the routed model accepts images. This mirrors the in-tree
 * `read_image` tool in dsh-tool-fs.
 *
 * The deliberate difference from `read_image`: where that tool REFUSES on a
 * text-only route (the image is its whole point), the capture tools here
 * DEGRADE. The primary output is always the JSON summary; the image block is an
 * enhancement added only when (a) the attachment store is mounted, (b) the
 * calling route's resolved model declares `image` input, and (c) admission
 * succeeds. Any failure in that chain silently keeps the text-only behavior, so
 * text-only routes, headless profiles, and older hosts never see a new error.
 *
 * Everything is typed structurally — the plugin is plain JS and must not depend
 * on the host's attachment type exports.
 * @module vision
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Resolve the optional vision services from the plugin context. Both come back
 * absent on hosts that do not mount them; every consumer treats that as
 * "stay text-only".
 */
export function resolveVisionServices(ctx) {
  const get = typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : undefined
  if (get === undefined) return {}
  const attachments = get('attachments')
  const llm = get('llm')
  return {
    ...(attachments !== undefined && typeof attachments.saveImage === 'function' ? { attachments } : {}),
    ...(llm !== undefined && typeof llm.resolveModelInfo === 'function' ? { llm } : {}),
  }
}

/**
 * True when the calling route's resolved model declares `image` input. Mirrors
 * `read_image`'s gate (request-header config first, then agent options) but
 * answers false instead of throwing: a tool result that enters durable history
 * must not carry an image its route cannot replay.
 */
export async function imageInputActive(services, exec) {
  if (services.llm === undefined || services.attachments === undefined) return false
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (provider === undefined || model === undefined) return false
    const info = await services.llm.resolveModelInfo(provider, model, exec?.signal)
    return info?.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/**
 * Durably commit one screenshot PNG and return the plain reference for the
 * result value, or undefined when the store is absent or admission fails
 * (oversized, malformed) — never an error, per the degrade-not-refuse rule.
 */
export async function saveScreenshotAttachment(services, png, name) {
  const attachments = services.attachments
  if (attachments === undefined) return undefined
  try {
    const ref = await attachments.saveImage({ data: png, mediaType: 'image/png', name })
    if (typeof ref?.attachmentId !== 'string' || ref.attachmentId === '') return undefined
    return {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
    }
  } catch {
    return undefined
  }
}

/**
 * Convenience for the capture tools: gate on the route, read the file, and save
 * the attachment — returning undefined (degrade) on any miss. Never throws.
 */
export async function maybeAttachScreenshot(services, filePath, exec) {
  if (services.attachments === undefined || typeof filePath !== 'string' || filePath === '') return undefined
  if (!(await imageInputActive(services, exec))) return undefined
  try {
    const data = await readFile(filePath)
    return await saveScreenshotAttachment(services, data, path.basename(filePath))
  } catch {
    return undefined
  }
}

/** Output-schema fragment for the optional `image` result field. */
export const IMAGE_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Durable attachment reference for the screenshot delivered to the model as an image block '
    + '(present only when the routed model declares image input).',
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    name: { type: 'string' },
  },
}

/**
 * Append the image block to a render's content blocks when the value carries an
 * `image` ref — so an image-capable model SEES the screen. Returns the same
 * array for chaining.
 */
export function appendImageBlock(blocks, value) {
  const image = value?.image
  if (image !== undefined && typeof image.attachmentId === 'string') {
    blocks.push({ type: 'image', attachment: image })
  }
  return blocks
}

/**
 * Ollama（本机，实验性）：OpenAI 兼容 /v1/images/generations（官方 API 文档）。
 *
 * 能力边界（如实提示）：
 * - 文生图：实验性（macOS/MLX 先支持，Windows/Linux 在途），API 形态与 openai-images 相同；
 * - 图生图：尚未开放（返回明确错误）；
 * - 默认 base：http://localhost:11434/v1（需 allowPrivateHosts）。
 */
import { ProviderError } from './errors.js'
import { generateOpenAICompat } from './openai-compat.js'

export const kind = 'ollama'

export async function generate(provider, request, deps = {}) {
  if (request.mode === 'i2i') {
    throw new ProviderError('Ollama 当前未开放图生图（图像编辑能力在官方路线图中）', {
      code: 'unsupported',
      providerId: provider.id,
      model: request.model ?? provider.model,
    })
  }
  return generateOpenAICompat(provider, request, deps)
}

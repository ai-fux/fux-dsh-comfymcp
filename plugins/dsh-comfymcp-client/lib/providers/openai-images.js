/**
 * OpenAI 兼容图像服务（DALL·E 风格 /images/generations + /images/edits）。
 * 覆盖：OpenAI、one-api/new-api 等网关、其他自定义 OpenAI 兼容服务。
 */
import { generateOpenAICompat } from './openai-compat.js'

export const kind = 'openai-images'

export function generate(provider, request, deps = {}) {
  return generateOpenAICompat(provider, request, deps)
}

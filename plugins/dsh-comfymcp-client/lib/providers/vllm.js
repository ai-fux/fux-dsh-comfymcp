/**
 * vLLM-omni（自建）：DALL·E 兼容 /v1/images/generations。
 * 原生 vLLM 只跑 LLM/VLM，图像生成需要 vllm-omni 或外挂 OpenAI 网关。
 */
import { generateOpenAICompat } from './openai-compat.js'

export const kind = 'vllm'

export function generate(provider, request, deps = {}) {
  return generateOpenAICompat(provider, request, deps)
}

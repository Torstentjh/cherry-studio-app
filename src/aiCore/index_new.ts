/**
 * Cherry Studio AI Core - 新版本入口
 * 集成 @cherrystudio/ai-core 库的渐进式重构方案
 *
 * 融合方案：简化实现，专注于核心功能
 * 1. 优先使用新AI SDK
 * 2. 失败时fallback到原有实现
 * 3. 暂时保持接口兼容性
 */
import {
  createExecutor,
  ProviderConfigFactory,
  type ProviderId,
  type ProviderSettingsMap,
  StreamTextParams
} from '@cherrystudio/ai-core'
import { fetch as expoFetch } from 'expo/fetch'
import { cloneDeep } from 'lodash'

import { GenerateImageParams, isDedicatedImageGenerationModel } from '@/config/models/image'
import { Model, Provider } from '@/types/assistant'
import { formatApiHost } from '@/utils/api'

import LegacyAiProvider from '.'
import AiSdkToChunkAdapter from './AiSdkToChunkAdapter'
import { AiSdkMiddlewareConfig, buildAiSdkMiddlewares } from './middleware/aisdk/AiSdkMiddlewareBuilder'
import { CompletionsResult } from './middleware/schemas'
import reasonPlugin from './plugins/reasonPlugin'
import textPlugin from './plugins/textPlugin'
import { getAiSdkProviderId } from './provider/factory'

/**
 * 将 Provider 配置转换为新 AI SDK 格式
 */
function providerToAiSdkConfig(provider: Provider): {
  providerId: ProviderId | 'openai-compatible'
  options: ProviderSettingsMap[keyof ProviderSettingsMap]
} {
  // 如果是 vertexai 类型且没有 googleCredentials，转换为 VertexProvider
  const actualProvider = cloneDeep(provider)

  // if (provider.type === 'vertexai' && !isVertexProvider(provider)) {
  //   if (!isVertexAIConfigured()) {
  //     throw new Error('VertexAI is not configured. Please configure project, location and service account credentials.')
  //   }

  //   actualProvider = createVertexProvider(provider)
  // }

  if (actualProvider.type === 'openai' || actualProvider.type === 'anthropic') {
    actualProvider.apiHost = formatApiHost(actualProvider.apiHost)
  }

  const aiSdkProviderId = getAiSdkProviderId(actualProvider)

  if (aiSdkProviderId !== 'openai-compatible') {
    const options = ProviderConfigFactory.fromProvider(aiSdkProviderId, {
      ...actualProvider
      // 使用ai-sdk内置的baseURL
      // baseURL: actualProvider.apiHost
    })

    return {
      providerId: aiSdkProviderId as ProviderId,
      options
    }
  } else {
    console.log(`Using openai-compatible fallback for provider: ${actualProvider.type}`)
    const options = ProviderConfigFactory.createOpenAICompatible(actualProvider.apiHost, actualProvider.apiKey)

    return {
      providerId: 'openai-compatible',
      options: {
        ...options,
        name: actualProvider.id
      }
    }
  }
}

/**
 * 检查是否支持使用新的AI SDK
 */
function isModernSdkSupported(provider: Provider, model?: Model): boolean {
  // 目前支持主要的providers
  const supportedProviders = ['openai', 'anthropic', 'gemini', 'azure-openai', 'vertexai']

  // 检查provider类型
  if (!supportedProviders.includes(provider.type)) {
    return false
  }

  // 对于 vertexai，检查配置是否完整
  // if (provider.type === 'vertexai' && !isVertexAIConfigured()) {
  //   return false
  // }

  // 检查是否为图像生成模型（暂时不支持）
  if (model && isDedicatedImageGenerationModel(model)) {
    return false
  }

  return true
}

export default class ModernAiProvider {
  private legacyProvider: LegacyAiProvider
  private modernExecutor?: ReturnType<typeof createExecutor>
  private provider: Provider

  constructor(provider: Provider) {
    this.provider = provider
    this.legacyProvider = new LegacyAiProvider(provider)

    const customFetch = async (url, options) => {
      const response = await expoFetch(url, {
        ...options,
        headers: {
          ...options.headers
        }
      })
      return response
    }

    // TODO:如果后续在调用completions时需要切换provider的话,
    // 初始化时不构建中间件，等到需要时再构建
    const config = providerToAiSdkConfig(provider)
    config.options.fetch = customFetch
    this.modernExecutor = createExecutor(config.providerId, config.options, [
      reasonPlugin({
        delayInMs: 80,
        chunkingRegex: /([\u4E00-\u9FFF]{3})|\S+\s+/
      }),
      textPlugin
    ])
  }

  public async completions(
    modelId: string,
    params: StreamTextParams,
    middlewareConfig: AiSdkMiddlewareConfig
  ): Promise<CompletionsResult> {
    // const model = params.assistant.model

    // 检查是否应该使用现代化客户端
    // if (this.modernClient && model && isModernSdkSupported(this.provider, model)) {
    // try {
    console.log('completions', modelId, params, middlewareConfig)
    return await this.modernCompletions(modelId, params, middlewareConfig)
    // } catch (error) {
    // console.warn('Modern client failed, falling back to legacy:', error)
    // fallback到原有实现
    // }
    // }

    // 使用原有实现
    // return this.legacyProvider.completions(params, options)
  }

  /**
   * 使用现代化AI SDK的completions实现
   * 使用建造者模式动态构建中间件
   */
  private async modernCompletions(
    modelId: string,
    params: StreamTextParams,
    middlewareConfig: AiSdkMiddlewareConfig
  ): Promise<CompletionsResult> {
    if (!this.modernExecutor) {
      throw new Error('Modern AI SDK client not initialized')
    }

    try {
      // 合并传入的配置和实例配置
      const finalConfig: AiSdkMiddlewareConfig = {
        ...middlewareConfig,
        provider: this.provider,
        // 工具相关信息从 params 中获取
        enableTool: !!Object.keys(params.tools || {}).length
      }

      // 动态构建中间件数组
      const middlewares = buildAiSdkMiddlewares(finalConfig)
      console.log('构建的中间件:', middlewares)

      // 创建带有中间件的执行器
      if (middlewareConfig.onChunk) {
        // 流式处理 - 使用适配器
        const adapter = new AiSdkToChunkAdapter(middlewareConfig.onChunk)
        // this.modernExecutor.pluginEngine.use(
        //   createMCPPromptPlugin({
        //     mcpTools: middlewareConfig.mcpTools || [],
        //     assistant: params.assistant,
        //     onChunk: middlewareConfig.onChunk,
        //     recursiveCall: this.modernExecutor.streamText,
        //     recursionDepth: 0,
        //     maxRecursionDepth: 20
        //   })
        // )
        const streamResult = await this.modernExecutor.streamText(
          modelId,
          params,
          middlewares.length > 0 ? { middlewares } : undefined
        )

        const finalText = await adapter.processStream(streamResult)

        return {
          getText: () => finalText
        }
      } else {
        // 流式处理但没有 onChunk 回调
        const streamResult = await this.modernExecutor.streamText(
          modelId,
          params,
          middlewares.length > 0 ? { middlewares } : undefined
        )
        const finalText = await streamResult.text

        return {
          getText: () => finalText
        }
      }
    } catch (error) {
      console.error('Modern AI SDK error:', error)
      throw error
    }
  }

  // 代理其他方法到原有实现
  public async models() {
    return this.legacyProvider.models()
  }

  public async getEmbeddingDimensions(model: Model): Promise<number> {
    // todo: 使用现代化SDK获取嵌入维度
    return -1
  }

  public async generateImage(params: GenerateImageParams): Promise<string[]> {
    // todo: 使用现代化SDK生成图像
    return []
  }

  public getBaseURL(): string {
    return this.legacyProvider.getBaseURL()
  }

  public getApiKey(): string {
    return this.legacyProvider.getApiKey()
  }
}

// 为了方便调试，导出一些工具函数
export { isModernSdkSupported, providerToAiSdkConfig }

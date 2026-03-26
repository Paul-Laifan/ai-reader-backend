/**
 * AI Reader — Express 后端代理
 * 解决浏览器 CORS 限制，将 AI 请求代理到阿里云百炼 / OpenAI 等 API
 * 
 * 部署方式（任选其一）：
 * 
 * 【方式 A】Railway（推荐，免费）
 * 1. 将 server.js + package.json 推送至 GitHub 仓库
 * 2. 访问 railway.app，用 GitHub 登录
 * 3. New Project → Deploy from GitHub → 选择仓库
 * 4. 设置环境变量：DEEPSEEK_API_KEY=sk-xxx
 *    DEEPSEEK_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
 *    DEEPSEEK_MODEL=deepseek-v3.2
 * 5. 部署后获取 URL，如 https://xxx.railway.app
 * 6. 前端第62行改 BASE_URL = 'https://xxx.railway.app'
 * 
 * 【方式 B】Render
 * 1. 推送至 GitHub
 * 2. 访问 render.com → New → Web Service
 * 3. 设置相同的环境变量
 * 4. 记录部署后的 URL
 * 
 * 【方式 C】自托管（有钱柜 pi/云服务器）
 *   node server.js
 */

const http = require('http')
const https = require('https')
const url = require('url')

const PORT = process.env.PORT || 3001

// 读取环境变量（默认值适配阿里云百炼 + DeepSeek v3.2）
const API_KEY = process.env.DEEPSEEK_API_KEY || ''
const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
const API_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v3.2'

// 简单日志
const log = (level, msg) => console.log(`[${new Date().toISOString()}] [${level}] ${msg}`)

// 创建代理函数
function proxyRequest(req, res, targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl)
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: req.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        ...headers,
      },
      timeout: 90000,
    }

    const proxyReq = lib.request(options, proxyRes => {
      res.statusCode = proxyRes.statusCode
      Object.entries(proxyRes.headers).forEach(([k, v]) => res.setHeader(k, v))
      proxyRes.pipe(res, { end: true })
    })

    proxyReq.on('error', err => {
      log('ERROR', `代理请求失败: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `代理错误: ${err.message}` }))
      }
      reject(err)
    })

    proxyReq.on('timeout', () => {
      proxyReq.destroy()
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '请求超时' }))
      }
      reject(new Error('timeout'))
    })

    if (body) proxyReq.write(body)
    proxyReq.end()
  })
}

// 主服务器
const server = http.createServer(async (req, res) => {
  // CORS 预检
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  const pathname = url.parse(req.url).pathname

  // GET /health → 健康检查
  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      api_base: API_BASE,
      api_model: API_MODEL,
      has_key: !!API_KEY,
    }))
    return
  }

  // POST /api/chat → AI 对话代理（核心接口）
  if (req.method === 'POST' && pathname === '/api/chat') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body)
        const messages = parsed.messages || []
        const model = parsed.model || API_MODEL
        const max_tokens = parsed.max_tokens || 2000
        const temperature = parsed.temperature !== undefined ? parsed.temperature : 0.7
        const enable_thinking = parsed.enable_thinking !== undefined ? parsed.enable_thinking : false

        log('INFO', `收到请求: model=${model}, msgs=${messages.length}`)

        const targetUrl = `${API_BASE}/chat/completions`
        const payload = JSON.stringify({
          model,
          messages,
          max_tokens,
          temperature,
          ...(enable_thinking ? { extra_body: { enable_thinking: true } } : {}),
        })

        const proxyHeaders = {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        }

        await proxyRequest(req, res, targetUrl, proxyHeaders, payload)
        log('INFO', `请求完成`)
      } catch (err) {
        log('ERROR', `处理失败: ${err.message}`)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      }
    })
    return
  }

  // 其他路径 404
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

server.listen(PORT, () => {
  console.log(`\n✅ AI Reader Backend 已启动`)
  console.log(`   端口: http://localhost:${PORT}`)
  console.log(`   端点: POST http://localhost:${PORT}/api/chat`)
  console.log(`   健康检查: GET http://localhost:${PORT}/health`)
  console.log(`\n   API 配置:`)
  console.log(`   - Base URL: ${API_BASE}`)
  console.log(`   - Model: ${API_MODEL}`)
  console.log(`   - API Key: ${API_KEY ? '✅ 已配置' : '❌ 未配置'}`)
  if (!API_KEY) {
    console.warn(`\n⚠️  未设置 API Key，请先设置环境变量 DEEPSEEK_API_KEY`)
  }
})

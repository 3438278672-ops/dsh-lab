import { listChats } from '../lib/db.mjs'
import { resolveChatKey } from '../lib/format.mjs'
import { readImpressionCard } from '../lib/impression.mjs'

/** qq_impression 工具：只放 schema 和 handler；运行时依赖由 rt 注入。 */
export default (rt) => ({
      name: 'qq_impression',
      description:
        '读某个群友缓存的「人物印象」：档案员按 TA 的聊天记录写过的一段小传 + 几个标签，只读、不调模型、不写库。' +
        '适合要画某个群友、按某个人的性格和口吻说话、或者想知道「XX 是个什么样的人」时当素材。' +
        'user 填 QQ 号（也接受昵称/群名片片段）；同名多号会返回候选，让你指定 QQ 号再查。' +
        '档案馆里还没攒够印象时 found=false，summary 会明说，照实告诉对方就行，别编。',
      parameters: {
        type: 'object',
        properties: {
          user: { type: 'string', description: 'QQ 号或昵称/群名片片段' },
          chat: { type: 'string', description: '限定会话：group:群号 / private:QQ号 / 群号 / 群名片段；不填=全档' },
        },
        required: ['user'],
      },
      timeoutMs: 60000,
      output: 'TEXT_SUMMARY',
      async execute(args = {}) {
        try {
          const user = String(args.user || '').trim()
          if (!user) return { ok: false, error: 'user 不能为空：填 QQ 号或昵称片段' }

          // 严格只读：不调 rt.ensureIndexed（那会触发同步、往库里写），库还没建好就按空档案回答
          const db = rt.ensureArchive().db

          let chatKey = null
          if (args.chat) {
            chatKey = resolveChatKey(db, args.chat)
            if (!chatKey) {
              return {
                ok: false,
                error: `没找到会话「${args.chat}」。已知会话：${listChats(db, 20)
                  .map((c) => `${c.key}${c.name ? `(${c.name})` : ''}`)
                  .join('、')}`,
              }
            }
          }

          return readImpressionCard(db, { user, chatKey })
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      },
})

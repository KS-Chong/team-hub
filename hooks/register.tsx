import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HubBoard, HubDecision, HubHandoff, HubPlan, HubStatus, HubStep } from '../types'
import { W, boardSvg, emptyQueueSvg, handoffRowSvg, offlineCardSvg, sectionSvg, usageTone } from './board-svg'
import type { UsageMeter } from './board-svg'
import { estimate, median, remainingText } from './estimate'
import {
  DECISION_CLOSE_SPEC,
  DECISION_CLOSE_TOOL,
  DECISION_SPEC,
  DECISION_TOOL,
  HANDOFF_DONE_SPEC,
  HANDOFF_DONE_TOOL,
  HANDOFF_SPEC,
  HANDOFF_TOOL,
  acceptPrompt,
  answerPrompt,
  buildHandoff,
  newDecisionId,
  rulesText,
} from './handoff'
import { VERSION } from './version'

const PANE = 'team-hub'
const NEW_DEPARTMENT = '__new__'
const tick = atom({ plugin: 'team-hub', key: 'tick' } as const, 0)
const name = atom({ plugin: 'team-hub', key: 'name' } as const, '')
const last = atom({ plugin: 'team-hub', key: 'last' } as const, '')
const since = atom({ plugin: 'team-hub', key: 'since' } as const, 0)
const steps = atom({ plugin: 'team-hub', key: 'steps' } as const, [] as HubStep[])
const notified = atom({ plugin: 'team-hub', key: 'notified' } as const, [] as string[])
const stepMark = atom({ plugin: 'team-hub', key: 'stepMark' } as const, 0)
const task = atom({ plugin: 'team-hub', key: 'task' } as const, '')
const stale = atom({ plugin: 'team-hub', key: 'stale' } as const, false)
const doneSeen = atom({ plugin: 'team-hub', key: 'doneSeen' } as const, {} as Record<string, number>)
// 正在问「只收起卡片 / 连部门一起删」的那张离线卡片(窗口的会话编号)
const removing = atom({ plugin: 'team-hub', key: 'removing' } as const, '')

const HANDOFF_FULL = `mcp__team-hub__${HANDOFF_TOOL}`
const HANDOFF_DONE_FULL = `mcp__team-hub__${HANDOFF_DONE_TOOL}`
const DECISION_FULL = `mcp__team-hub__${DECISION_TOOL}`
const DECISION_CLOSE_FULL = `mcp__team-hub__${DECISION_CLOSE_TOOL}`

// 做完一轮超过这么久,才通知其他窗口「XX 部门做完了」;短的来回不吵
const NOTIFY_DONE_AFTER = 3 * 60000

// 插件更新了,这个窗口还在跑旧版:比一下磁盘上的版本号
const checkVersion = async ($: EngineInterface) => {
  try {
    const text = String(await $.fs.read(`${$.plugin.root}/hooks/version.ts`))
    const onDisk = /VERSION = '([^']+)'/.exec(text)?.[1]
    if (onDisk && onDisk !== VERSION) await update($, stale, () => true)
  } catch {
    // 读不到就不提醒
  }
}

const SLASH = /[\\/]/
const baseName = (path: unknown) => String(path ?? '').split(SLASH).filter(Boolean).pop() ?? ''
const clip = (text: string, size = 40) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

// ---------- 看板放在项目外面:~/.claude/team-hub/boards/<项目路径拼成的名字>/,不进项目的 git ----------

const boardKey = (root: string) => root.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

// 这个窗口属于哪个项目:桌面版开在 worktree(项目的独立工作副本)里时,算回主项目,和其他窗口共用一块看板
const projectRoot = async ($: EngineInterface) => {
  const root = await $.session.root()
  try {
    const pointer = String(await $.fs.read(`${root}/.git`))
    if (pointer.startsWith('gitdir:') && /[\\/]worktrees[\\/]/.test(pointer)) {
      const repo = await $.session.repo()
      if (repo?.root) return repo.root
    }
  } catch {
    // .git 是文件夹(普通项目)或者没有 git:就用这个窗口自己的目录
  }
  return root
}

// 早期版本(插件还叫 lighthouse-hub)把看板放在 ~/.claude/lighthouse-hub/:那里已经有这个项目的看板就照旧用,不搬家
const LEGACY_DATA_DIRS = ['lighthouse-hub']

const boardDir = async ($: EngineInterface) => {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const key = boardKey(await projectRoot($))
  for (const legacy of LEGACY_DATA_DIRS) {
    const dir = `${home}/.claude/${legacy}/boards/${key}`
    if (await $.fs.exists(`${dir}/board.json`)) return dir
  }
  return `${home}/.claude/team-hub/boards/${key}`
}
const statusDir = async ($: EngineInterface) => `${await boardDir($)}/status`
const queueDir = async ($: EngineInterface) => `${await boardDir($)}/queue`

// 有 board.json = 这个项目开了指挥台;没开的项目里插件什么都不显示
const loadBoard = async ($: EngineInterface): Promise<HubBoard | undefined> => {
  try {
    return JSON.parse(String(await $.fs.read(`${await boardDir($)}/board.json`))) as HubBoard
  } catch {
    return undefined
  }
}
const saveBoard = async ($: EngineInterface, board: HubBoard) =>
  $.fs.write(`${await boardDir($)}/board.json`, JSON.stringify(board, null, 2))

const dutiesOf = (board: HubBoard | undefined) =>
  Object.fromEntries(Object.entries(board?.departments ?? {}).map(([one, info]) => [one, info.duty]))

const enableBoard = async ($: EngineInterface) => {
  const existing = await loadBoard($)
  if (existing) return existing
  const root = await projectRoot($)
  const board: HubBoard = { project: baseName(root), root, createdAt: Date.now(), departments: {} }
  await saveBoard($, board)
  await registerTools($)
  return board
}

const registerTools = async ($: EngineInterface) => {
  await $.tool.register(HANDOFF_SPEC)
  await $.tool.register(HANDOFF_DONE_SPEC)
  await $.tool.register(DECISION_SPEC)
  await $.tool.register(DECISION_CLOSE_SPEC)
}

// ---------- 等你决定 ----------

const decisionDir = async ($: EngineInterface) => `${await boardDir($)}/decisions`

const loadDecisions = async ($: EngineInterface) => {
  const dir = await decisionDir($)
  if (!(await $.fs.exists(dir))) return []
  const entries = (await $.fs.list(dir)).filter(one => one.kind === 'file' && one.name.endsWith('.json'))
  const all = await Promise.all(
    entries.map(one =>
      $.fs
        .read(`${dir}/${one.name}`)
        .then(text => JSON.parse(String(text)) as HubDecision)
        .catch(() => undefined),
    ),
  )
  return all.filter((one): one is HubDecision => one !== undefined).sort((a, b) => a.createdAt - b.createdAt)
}

const saveDecision = async ($: EngineInterface, item: HubDecision) =>
  $.fs.write(`${await decisionDir($)}/${item.id}.json`, JSON.stringify(item, null, 2))

// 老板在面板上回答:记下答案,由问的那个窗口自己取走(那个窗口每 5 秒看一次)
const answerDecision = async ($: EngineInterface, id: string, answer: string) => {
  const text = answer.trim()
  if (!text) return
  const item = (await loadDecisions($)).find(one => one.id === id)
  if (!item || item.status !== 'open') return
  await saveDecision($, { ...item, status: 'answered', answer: text, updatedAt: Date.now() })
  $.ui.toast(`已回答:${clip(item.question, 30)} → ${clip(text, 20)}`)
}

const closeDecision = async ($: EngineInterface, id: string) => {
  const item = (await loadDecisions($)).find(one => one.id === id)
  if (!item || item.status !== 'open') return
  await saveDecision($, { ...item, status: 'closed', updatedAt: Date.now() })
}

// ---------- 每个部门最近几轮 / 每步的实际用时,只拿来估剩余时间 ----------

const HISTORY = 15
const historyKey = async ($: EngineInterface, kind: 'turns' | 'stepms', department: string) =>
  `${boardKey(await projectRoot($))}:${kind}:${department}`
const readHistory = async ($: EngineInterface, key: string) => {
  const saved = await $.store.get(key)
  return Array.isArray(saved) ? saved.filter((n): n is number => typeof n === 'number' && n > 0) : []
}
const pushHistory = async ($: EngineInterface, key: string, ms: number) => {
  if (!(ms > 2000)) return
  await $.store.set(key, [...(await readHistory($, key)), Math.round(ms)].slice(-HISTORY))
}

// ---------- 这个窗口的状态 ----------

const describe = (tool: string, input: Record<string, unknown>) => {
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return `改 ${baseName(input.file_path ?? input.notebook_path)}`
  if (tool === 'Read') return `读 ${baseName(input.file_path)}`
  if (tool === 'Bash' || tool === 'PowerShell') return `跑命令：${clip(String(input.description ?? input.command ?? ''))}`
  if (tool === 'Grep' || tool === 'Glob') return `搜索 ${clip(String(input.pattern ?? ''), 30)}`
  if (tool === 'Agent') return `派子代理：${clip(String(input.description ?? ''))}`
  if (tool === 'SendMessage') return `发消息给 ${String(input.to ?? '')}`
  if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') return '更新步骤清单'
  if (tool === HANDOFF_FULL) return `交接给 ${String(input.to ?? '')}`
  if (tool === HANDOFF_DONE_FULL) return `交接 ${String(input.id ?? '')} 做完`
  if (tool === DECISION_FULL) return `等你决定:${clip(String(input.question ?? ''), 30)}`
  if (tool === DECISION_CLOSE_FULL) return `问题 ${String(input.id ?? '')} 已答`
  return `用 ${tool.replace(/^mcp__[^_]+__/, '')}`
}

// 步骤清单只照抄 AI 自己列的,不估算
const planOf = (list: HubStep[]): HubPlan | undefined => {
  if (list.length === 0) return undefined
  const current = list.find(one => one.status === 'in_progress') ?? list.find(one => one.status === 'pending')
  return {
    done: list.filter(one => one.status === 'completed').length,
    total: list.length,
    current: current?.title ?? '',
  }
}

// AI 改了步骤清单:TodoWrite 每次给整张清单;TaskCreate / TaskUpdate 一条一条改
const trackSteps = async ($: EngineInterface, tool: string, input: Record<string, unknown>, resultText: string) => {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos as Array<{ content?: string; activeForm?: string; status?: HubStep['status'] }>
    await update($, steps, () =>
      todos.map((one, i) => ({ id: String(i), title: String(one.activeForm || one.content || ''), status: one.status ?? 'pending' })),
    )
  }
  if (tool === 'TaskCreate') {
    const id = /#?(\d+)/.exec(resultText)?.[1]
    await update($, steps, list => [
      ...list,
      { id: id ?? String(list.length + 1), title: String(input.activeForm || input.subject || ''), status: 'pending' },
    ])
  }
  if (tool === 'TaskUpdate') {
    const id = String(input.taskId ?? '')
    await update($, steps, list =>
      input.status === 'deleted'
        ? list.filter(one => one.id !== id)
        : list.map(one =>
            one.id === id
              ? {
                  ...one,
                  title: String(input.activeForm || input.subject || one.title),
                  status: (input.status as HubStep['status'] | undefined) ?? one.status,
                }
              : one,
          ),
    )
  }
}

// 只有开了指挥台、而且这个窗口已经选了部门,才报到
const report = async ($: EngineInterface, state: HubStatus['state'], action?: string, done?: HubStatus['lastDone']) => {
  try {
    if (action !== undefined) await update($, last, () => action)
    const department = await read($, name)
    if (!department || !(await loadBoard($))) return
    const sessionId = await $.session.id()
    const path = `${await statusDir($)}/${sessionId}.json`
    // 上一次做完的记录要留着,别的窗口靠它判断要不要提醒
    const previous = done ?? (await $.fs.read(path).then(text => (JSON.parse(String(text)) as HubStatus).lastDone).catch(() => undefined))
    const startedAt = await read($, since)
    const mark = await read($, stepMark)
    const currentTask = await read($, task)
    const status: HubStatus = {
      lastDone: previous,
      task: state === 'busy' && currentTask ? currentTask : undefined,
      sessionId,
      name: department,
      state,
      last: await read($, last),
      at: Date.now(),
      seen: Date.now(),
      since: state === 'busy' && startedAt > 0 ? startedAt : undefined,
      plan: planOf(await read($, steps)),
      stepMark: mark > 0 ? mark : undefined,
      typicalTurnMs: median(await readHistory($, await historyKey($, 'turns', department))),
      typicalStepMs: median(await readHistory($, await historyKey($, 'stepms', department))),
    }
    await $.fs.write(path, JSON.stringify(status, null, 2))
  } catch {
    // 报到失败不能挡住正常工作
  }
}

// 心跳:只改 seen 和状态,不动「最后动作」的时间;插件重载时误写的「离线」也在这里改回来
const beat = async ($: EngineInterface) => {
  if (!(await read($, name))) return
  try {
    const path = `${await statusDir($)}/${await $.session.id()}.json`
    const saved = JSON.parse(String(await $.fs.read(path))) as HubStatus
    const state: HubStatus['state'] = (await read($, since)) > 0 ? 'busy' : 'idle'
    await $.fs.write(path, JSON.stringify({ ...saved, state, seen: Date.now() }, null, 2))
  } catch {
    await report($, (await read($, since)) > 0 ? 'busy' : 'idle')
  }
}

// 选部门:选了已有的部门 = 接替那张卡片;新部门顺便记下分工
const setName = async ($: EngineInterface, value: string, duty?: string) => {
  const board = await enableBoard($)
  const known = board.departments[value]
  if (!known || (duty !== undefined && duty !== '')) {
    await saveBoard($, { ...board, departments: { ...board.departments, [value]: { duty: duty ?? known?.duty ?? '' } } })
  }
  await update($, name, () => value)
  await $.store.set(`name:${await $.session.id()}`, value)
  await report($, 'idle')
}

const ago = (at: number) => {
  const minutes = Math.floor((Date.now() - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

const elapsed = (from: number) => {
  const minutes = Math.floor((Date.now() - from) / 60000)
  if (minutes < 1) return '刚开始'
  if (minutes < 60) return `已工作 ${minutes} 分钟`
  return `已工作 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

const OFFLINE_AFTER = 3 * 60000

// 超过 3 分钟没心跳就当离线(窗口被直接关掉时不一定来得及写「离线」)
const withLiveness = (one: HubStatus, now: number): HubStatus =>
  one.state !== 'offline' && now - (one.seen ?? one.at) > OFFLINE_AFTER ? { ...one, state: 'offline' } : one

// 离线卡片上的 ×:只收起卡片(那个窗口再开工会自己回来),或者连部门一起删(「选部门」里不再列)
const hideCard = async ($: EngineInterface, sessionId: string) => {
  const path = `${await statusDir($)}/${sessionId}.json`
  try {
    const saved = JSON.parse(String(await $.fs.read(path))) as HubStatus
    await $.fs.write(path, JSON.stringify({ ...saved, hiddenAt: Date.now() }, null, 2))
  } catch {
    // 文件读不到就当已经没了
  }
  await update($, removing, () => '')
}

const removeDepartment = async ($: EngineInterface, sessionId: string, department: string) => {
  await hideCard($, sessionId)
  const board = await loadBoard($)
  if (!board || !board.departments[department]) return
  const { [department]: _gone, ...rest } = board.departments
  await saveBoard($, { ...board, departments: rest })
  $.ui.toast(`已删除部门「${department}」`)
}

const loadAll = async ($: EngineInterface) => {
  const dir = await statusDir($)
  if (!(await $.fs.exists(dir))) return []
  const entries = (await $.fs.list(dir)).filter(one => one.kind === 'file' && one.name.endsWith('.json'))
  const all = await Promise.all(
    entries.map(one =>
      $.fs
        .read(`${dir}/${one.name}`)
        .then(text => JSON.parse(String(text)) as HubStatus)
        .catch(() => undefined),
    ),
  )
  const now = Date.now()
  // 同一个部门开过新窗口:只留最近还在动的那张卡片
  const byName = new Map<string, HubStatus>()
  for (const one of all) {
    if (one === undefined || !one.name || one.name.startsWith('未命名 ')) continue
    // 老板收起过、之后那个窗口也没再报到:不列
    if (one.hiddenAt && one.hiddenAt >= (one.seen ?? one.at)) continue
    const live = withLiveness(one, now)
    const kept = byName.get(live.name)
    if (!kept || (live.seen ?? live.at) > (kept.seen ?? kept.at)) byName.set(live.name, live)
  }
  return [...byName.values()]
    .filter(one => !(one.state === 'offline' && now - one.at > 24 * 3600000))
    .sort((a, b) => (a.state === 'offline' ? 1 : 0) - (b.state === 'offline' ? 1 : 0) || b.at - a.at)
}

// ---------- 交接队列 ----------

const ENDED: HubHandoff['status'][] = ['done', 'declined', 'withdrawn']
const CLEAR_AFTER = 3600000

const loadHandoffs = async ($: EngineInterface) => {
  const dir = await queueDir($)
  if (!(await $.fs.exists(dir))) return []
  const entries = (await $.fs.list(dir)).filter(one => one.kind === 'file' && one.name.endsWith('.json'))
  const all = await Promise.all(
    entries.map(one =>
      $.fs
        .read(`${dir}/${one.name}`)
        .then(text => JSON.parse(String(text)) as HubHandoff)
        .catch(() => undefined),
    ),
  )
  return all.filter((one): one is HubHandoff => one !== undefined).sort((a, b) => b.createdAt - a.createdAt)
}

const saveHandoff = async ($: EngineInterface, item: HubHandoff) =>
  $.fs.write(`${await queueDir($)}/${item.id}.json`, JSON.stringify(item, null, 2))

// 队列只放没清掉的:结束的(完成 / 退回 / 撤回)1 小时后自动消失
const visibleHandoffs = (list: HubHandoff[], now: number) =>
  list.filter(one => !one.clearedAt && !(ENDED.includes(one.status) && now - one.updatedAt > CLEAR_AFTER)).slice(0, 8)

const myName = async ($: EngineInterface) => ({ sessionId: await $.session.id(), name: await read($, name) })

// 交给这个窗口的:按会话认,窗口重开过就按部门名认
const isMine = (item: HubHandoff, me: { sessionId: string; name: string }) =>
  item.toSession === me.sessionId || (me.name !== '' && item.to === me.name)
const isSentByMe = (item: HubHandoff, me: { sessionId: string; name: string }) =>
  item.fromSession === me.sessionId || (me.name !== '' && item.from === me.name)

const setStatus = async ($: EngineInterface, id: string, status: HubHandoff['status'], extra: Partial<HubHandoff> = {}) => {
  const item = (await loadHandoffs($)).find(one => one.id === id)
  if (item === undefined) return undefined
  const next = { ...item, status, updatedAt: Date.now(), ...extra }
  await saveHandoff($, next)
  return next
}

const clearHandoff = async ($: EngineInterface, item: HubHandoff) => {
  const now = Date.now()
  const all = await loadHandoffs($)
  const saved = all.find(one => one.id === item.id)
  // 只清已经结束的;还在进行的不给清
  if (!saved || !ENDED.includes(saved.status)) return
  await saveHandoff($, { ...saved, clearedAt: now })
}

// 每 5 秒:有新交接弹一次提醒;结束超过 1 小时的记下清掉的时间(文件留着当存档)
const checkInbox = async ($: EngineInterface) => {
  try {
    const me = await myName($)
    if (!me.name) return
    const all = await loadHandoffs($)
    const now = Date.now()
    for (const one of all) {
      if (!one.clearedAt && ENDED.includes(one.status) && now - one.updatedAt > CLEAR_AFTER) {
        await saveHandoff($, { ...one, clearedAt: now })
      }
    }
    const seen = await read($, notified)
    const fresh = all.filter(one => one.status === 'waiting' && isMine(one, me) && !seen.includes(one.id))
    if (fresh.length === 0) return
    await update($, notified, list => [...list, ...fresh.map(one => one.id)].slice(-200))
    void openPane($)
    for (const one of fresh) {
      $.ui.toast(`${one.from} 交接给你:${one.title}。在指挥台按「接手」才开始。`, { timeoutMs: 12000 })
      void $.ui.notify(`${one.from}:${one.title}`, { title: `${me.name} 收到交接` }).catch(() => undefined)
    }
  } catch {
    // 看不到队列不影响工作
  }
}

const minutesText = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60000))
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

// 别的部门做完一轮长活:在这个窗口弹一下(系统通知只由做完的那个窗口自己发,免得几个窗口各发一次)
const checkDone = async ($: EngineInterface) => {
  try {
    const me = await myName($)
    if (!me.name) return
    const seen = await read($, doneSeen)
    const now = Date.now()
    const fresh: HubStatus[] = []
    const next: Record<string, number> = { ...seen }
    for (const one of await loadAll($)) {
      const done = one.lastDone
      if (!done || one.sessionId === me.sessionId || done.at <= (seen[one.sessionId] ?? 0)) continue
      next[one.sessionId] = done.at
      // 第一次看到这个窗口时,旧的完成记录不补弹
      if (seen[one.sessionId] === undefined && now - done.at > 60000) continue
      fresh.push(one)
    }
    if (Object.keys(next).length !== Object.keys(seen).length || fresh.length > 0) await update($, doneSeen, () => next)
    for (const one of fresh) {
      const done = one.lastDone!
      $.ui.toast(`${one.name} 做完了${done.task ? `:${clip(done.task, 30)}` : ''}(${minutesText(done.ms)})`, { timeoutMs: 10000 })
    }
  } catch {
    // 看不到就算了
  }
}

// 老板在面板上回答了这个窗口问的事:把答案作为一条新消息送进来
const deliverAnswers = async ($: EngineInterface) => {
  try {
    const me = await myName($)
    if (!me.name) return
    for (const one of await loadDecisions($)) {
      const mine = one.fromSession === me.sessionId || one.from === me.name
      if (!mine || one.status !== 'answered' || !one.answer) continue
      // 先标已送达再送,两个窗口同时看到也只送一次
      await saveDecision($, { ...one, status: 'delivered', updatedAt: Date.now() })
      await $.prompt.submit({ text: answerPrompt(one.question, one.answer, one.id) })
    }
  } catch {
    // 送不进去就等下一次
  }
}

const openPane = async ($: EngineInterface) => {
  try {
    const board = await loadBoard($)
    await $.ui.open({ id: PANE, title: `${board?.project ?? baseName(await projectRoot($))} 指挥台` })
  } catch {
    // 这个界面放不下面板就算了,输入框上方那条还在
  }
}

// 账户额度(5 小时 / 每周):整个账户共用,哪个窗口读都一样
const readUsage = async ($: EngineInterface): Promise<UsageMeter[]> => {
  try {
    return [...(await $.session.usage()).rateLimits]
  } catch {
    return []
  }
}

// 输入框上方那一行:有交接等你最要紧,其次是等你决定的事,再其次是谁在工作、做到多少
const bandSummary = (all: HubStatus[], waiting: HubHandoff[], asked: HubDecision[], now: number) => {
  if (waiting.length > 0) {
    const first = waiting[0]
    const more = waiting.length > 1 ? ` 等 ${waiting.length} 条` : ''
    return { tone: 'warning' as const, text: `${first.from} 交接给你:${clip(first.title, 24)}${more} · 等你接手` }
  }
  if (asked.length > 0) {
    const first = asked[0]
    const more = asked.length > 1 ? ` 等 ${asked.length} 件` : ''
    return { tone: 'warning' as const, text: `${first.from} 等你决定:${clip(first.question, 26)}${more}` }
  }
  const busy = all.filter(one => one.state === 'busy')
  if (busy.length === 0) return { tone: 'idle' as const, text: `${all.filter(one => one.state === 'idle').length} 个部门空闲` }
  const parts = busy.slice(0, 3).map(one => {
    const guess = estimate(one, now)
    return guess ? `${one.name} ${Math.round(guess.pct * 100)}% · ${remainingText(guess)}` : one.name
  })
  return { tone: 'busy' as const, text: `${parts.join('  |  ')}${busy.length > 3 ? `  +${busy.length - 3}` : ''}` }
}

// 额度快用完才在那一行多一小段
const usageAlert = (usage: UsageMeter[]) =>
  usage
    .filter(one => usageTone(one.percentUsed) !== 'normal' && (one.kind === 'five_hour' || one.kind === 'seven_day'))
    .map(one => `${one.kind === 'five_hour' ? '5h' : '周'} ${Math.round(one.percentUsed)}%`)
    .join(' · ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hub', description: '打开这个项目的指挥台(还没开就开启它)' })
    await $.command.register({
      name: 'hub-name',
      description: '设定这个窗口的部门,例如 /hub-name 代码部门 | 页面、模板、JS',
      argumentHint: '<部门名称> | <一句话分工>',
    })
    const saved = await $.store.get(`name:${await $.session.id()}`)
    if (typeof saved === 'string' && saved !== '') {
      await update($, name, () => saved)
    } else {
      // 记不得自己是哪个部门(插件换过名字、重装过):从看板上自己那张卡片读回来,不用重新选
      try {
        const card = JSON.parse(String(await $.fs.read(`${await statusDir($)}/${await $.session.id()}.json`))) as HubStatus
        if (card.name) {
          await update($, name, () => card.name)
          await $.store.set(`name:${await $.session.id()}`, card.name)
        }
      } catch {
        // 这个窗口还没加入过
      }
    }
    const board = await loadBoard($)
    if (board) await registerTools($)
    $.clock.every(5000, () => {
      void update($, tick, n => n + 1)
      void checkInbox($)
      void checkDone($)
      void deliverAnswers($)
    })
    $.clock.every(30000, () => {
      void beat($)
      void checkVersion($)
    })
    await report($, 'idle')
    // 开了指挥台的项目,窗口一开就把面板放在旁边(只在能停靠成侧栏的地方);
    // 还没选部门的新窗口,面板最上面就是「选部门」
    if (board && e.surface !== 'terminal') void openPane($)

    return next(e)
  })

  // 协作规矩由插件自带:开了指挥台、选了部门的窗口,系统提示里多一段
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const department = await read($, name)
    const board = department ? await loadBoard($) : undefined
    if (!board || !department) return composed
    const me = await myName($)
    const open = (await loadHandoffs($))
      .filter(one => one.status === 'accepted' && isMine(one, me))
      .map(one => ({ id: one.id, from: one.from, title: one.title, acceptedAgo: ago(one.updatedAt) }))
    const asked = (await loadDecisions($))
      .filter(one => one.status === 'open' && (one.fromSession === me.sessionId || one.from === me.name))
      .map(one => ({ id: one.id, question: one.question }))
    return {
      ...composed,
      sections: [
        ...composed.sections,
        { id: 'team-hub', text: rulesText(board.project, department, dutiesOf(board), open, asked), scope: 'session' as const },
      ],
    }
  })

  // 输入框上方:没开指挥台的项目什么都不出;开了但这个窗口还没选部门 → 「加入指挥台」;否则「指挥台」按钮 + 一句摘要
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick)
    const board = await loadBoard($)
    if (!board) return next(e)
    const self = await myName($)

    // 插件改过、这个窗口还在跑旧版:先提醒重新加载,其他都往后放
    if (await read($, stale)) {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box>
          <Text color="warning" bold>
            指挥台已更新,请在这个窗口执行 /reload-plugins
          </Text>
        </Box>
      )
    }

    if (!self.name) {
      const { Box, Text, Select } = $.ui.resolve(e)
      const options = [
        ...Object.keys(board.departments).map(one => ({ value: one, label: one })),
        { value: NEW_DEPARTMENT, label: '新部门…' },
      ]
      const choose = async (value: string) => {
        if (value === NEW_DEPARTMENT) {
          await $.prompt.fill({ text: '/hub-name 部门名称 | 一句话分工', mode: 'replace' }).catch(() => undefined)
          return
        }
        await setName($, value)
      }
      if (Select === undefined) {
        return (
          <Box>
            <Text dimColor>这个窗口还没加入 {board.project} 指挥台:输入 /hub-name 部门名称</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color="warning">加入 {board.project} 指挥台</Text>
          <Select key="hub-join" label="选部门" options={options} onSelect={value => void choose(value)} />
        </Box>
      )
    }

    const all = await loadAll($)
    const waiting = (await loadHandoffs($)).filter(one => one.status === 'waiting' && isMine(one, self))
    const asked = (await loadDecisions($)).filter(one => one.status === 'open')
    const summary = bandSummary(all, waiting, asked, Date.now())
    const alert = usageAlert(await readUsage($))
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="hub-open" variant={summary.tone === 'warning' ? 'primary' : 'secondary'} onPress={() => openPane($)}>
          指挥台
        </Button>
        <Text color={summary.tone === 'warning' ? 'warning' : summary.tone === 'busy' ? 'success' : undefined} dimColor={summary.tone === 'idle'} wrap="truncate-end">
          {summary.text}
        </Text>
        {alert ? <Text color="warning">· {alert}</Text> : ''}
      </Box>
    )
  })

  on('tool.call', { tool: HANDOFF_FULL }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as Record<string, unknown>
    const board = await loadBoard($)
    if (!board) return { result: '这个项目没开指挥台,交接没写进去。' }
    const me = await myName($)
    if (!me.name) return { result: '这个窗口还没选部门,交接没写进去。请老板在输入框上方「加入指挥台」选一个部门。' }
    const made = buildHandoff(await loadAll($), me, input, dutiesOf(board))
    if (made.item) await saveHandoff($, made.item)
    return { result: made.text }
  })

  on('tool.call', { tool: HANDOFF_DONE_FULL }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as Record<string, unknown>
    const id = String(input.id ?? '')
    const item = (await loadHandoffs($)).find(one => one.id === id)
    if (item === undefined) return { result: `没有编号 ${id} 的交接。` }
    if (!isMine(item, await myName($))) return { result: `${id} 不是交给这个窗口的(收件:${item.to}),没改。` }
    await setStatus($, id, 'done', input.note ? { note: String(input.note) } : {})
    return { result: `已把 ${id} 标为做完。指挥台上 ${item.from} 那边看得到。` }
  })

  on('tool.call', { tool: DECISION_FULL }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as Record<string, unknown>
    const me = await myName($)
    if (!(await loadBoard($)) || !me.name) return { result: '这个窗口没加入指挥台,问题没登记。直接在聊天里问老板。' }
    const question = String(input.question ?? '').trim()
    if (!question) return { result: '问题没登记:question 要写。' }
    const options = Array.isArray(input.options) ? input.options.map(String).map(one => one.trim()).filter(Boolean).slice(0, 4) : []
    const now = Date.now()
    const item: HubDecision = {
      id: newDecisionId(),
      from: me.name,
      fromSession: me.sessionId,
      question,
      options,
      context: input.context ? String(input.context) : undefined,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    }
    await saveDecision($, item)
    void $.ui.notify(question, { title: `${me.name} 等你决定` }).catch(() => undefined)
    return {
      result: `已登记到「等你决定」(${item.id})。现在停下来等老板;老板在面板上回答后,答案会作为一条新消息送进这个窗口。老板在聊天里直接回答的话,用 close_decision 把它拿掉。`,
    }
  })

  on('tool.call', { tool: DECISION_CLOSE_FULL }, async ($, e) => {
    const input = ((e as { input?: unknown }).input ?? e) as Record<string, unknown>
    const id = String(input.id ?? '')
    const me = await myName($)
    const item = (await loadDecisions($)).find(one => one.id === id)
    if (!item) return { result: `没有编号 ${id} 的问题。` }
    if (item.fromSession !== me.sessionId && item.from !== me.name) return { result: `${id} 不是这个窗口问的,没改。` }
    await closeDecision($, id)
    return { result: `已把 ${id} 从「等你决定」拿掉。` }
  })

  on('command.run', { command: 'hub' }, async $ => {
    await openPane($)
    return { text: (await loadBoard($)) ? '已打开指挥台。' : '这个项目还没开指挥台,面板里按「开启」就好。' }
  })

  on('command.run', { command: 'hub-name' }, async ($, e) => {
    const [rawName, ...rest] = e.args.split(/[|｜]/)
    const value = (rawName ?? '').trim()
    const duty = rest.join('|').trim()
    if (value === '' || value === '部门名称') {
      return { text: `这个窗口现在${(await read($, name)) ? `是「${await read($, name)}」` : '还没选部门'}。用 /hub-name 代码部门 | 页面、模板、JS 来设定。` }
    }
    await setName($, value, duty)
    return { text: `这个窗口已加入指挥台:「${value}」${duty ? `(${duty})` : ''}。` }
  })

  on('prompt.submit', async ($, e, next) => {
    // 这一轮老板交代的事:第一行的开头,做完时拿来写通知;一轮里接着补充的话不换掉它
    const firstLine = String(e.text ?? '').trim().split('\n')[0] ?? ''
    if ((await read($, since)) === 0 && firstLine && !firstLine.startsWith('/')) await update($, task, () => clip(firstLine, 40))
    await update($, since, n => (n > 0 ? n : Date.now()))
    await report($, 'busy', '收到新指令')
    await checkVersion($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    await update($, since, n => (n > 0 ? n : Date.now()))
    await report($, 'busy', describe(tool, input))
    const ran = await next(e)
    if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') {
      try {
        const doneBefore = planOf(await read($, steps))?.done ?? 0
        await trackSteps($, tool, input, String((ran as { text?: unknown }).text ?? ''))
        const doneAfter = planOf(await read($, steps))?.done ?? 0
        // 又做完了几步:记下每步用时,给以后估时用
        const department = await read($, name)
        if (doneAfter > doneBefore && department) {
          const now = Date.now()
          const from = (await read($, stepMark)) || (await read($, since)) || now
          const key = await historyKey($, 'stepms', department)
          for (let i = doneBefore; i < doneAfter; i += 1) await pushHistory($, key, (now - from) / (doneAfter - doneBefore))
          await update($, stepMark, () => now)
        }
        await report($, 'busy')
      } catch {
        // 步骤记不下来不影响工作
      }
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    // 子代理的回合结束不算这个窗口空闲
    if ((e as { agentId?: string }).agentId === undefined) {
      const startedAt = await read($, since)
      const department = await read($, name)
      const now = Date.now()
      const ms = startedAt > 0 ? now - startedAt : 0
      if (startedAt > 0 && department) await pushHistory($, await historyKey($, 'turns', department), ms)
      const doneTask = await read($, task)
      await update($, since, () => 0)
      await update($, stepMark, () => 0)
      await update($, task, () => '')
      // 清单全做完了就收起;没做完留着,下一轮接着走
      await update($, steps, list => (list.every(one => one.status === 'completed') ? [] : list))
      // 做了一轮长活:记下来让其他窗口弹提示,系统通知由这个窗口自己发一次
      const longTurn = department && ms >= NOTIFY_DONE_AFTER
      await report($, 'idle', undefined, longTurn ? { at: now, ms, task: doneTask } : undefined)
      if (longTurn) {
        void $.ui
          .notify(`${doneTask ? `${doneTask} · ` : ''}用了 ${minutesText(ms)}`, { title: `${department} 做完了` })
          .catch(() => undefined)
      }
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await report($, 'offline')

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const board = await loadBoard($)

    // 这个项目还没开:只放一个「开启」
    if (!board) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const project = baseName(await projectRoot($))
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>
          <Text bold>{project} 还没开指挥台</Text>
          <Text dimColor>开了以后,这个项目的每个 Claude 窗口选一个部门,就能互相看到在做什么、互相交接。只开一个窗口的项目不用开。</Text>
          <Box>
            <Button key="hub-enable" variant="primary" onPress={() => void enableBoard($)}>
              开启指挥台
            </Button>
          </Box>
        </Box>
      )
    }

    const me = await $.session.id()
    const self = await myName($)
    const all = await loadAll($)
    const handoffs = await loadHandoffs($)
    const now = Date.now()
    const waiting = handoffs.filter(one => one.status === 'waiting' && isMine(one, self))
    const shown = visibleHandoffs(handoffs, now)
    const open = handoffs.filter(one => one.status === 'waiting' || one.status === 'accepted').length
    const usage = await readUsage($)
    const asked = (await loadDecisions($)).filter(one => one.status === 'open')
    const offline = all.filter(one => one.state === 'offline')
    const pendingRemove = await read($, removing)

    const accept = async (item: HubHandoff) => {
      const next = await setStatus($, item.id, 'accepted')
      if (next === undefined || next.status !== 'accepted') return
      $.ui.toast(`已接手 ${item.title}`)
      await $.prompt.submit({ text: acceptPrompt(item) })
    }
    const decline = async (item: HubHandoff) => {
      await setStatus($, item.id, 'declined')
      $.ui.toast(`已退回 ${item.title}`)
    }
    // × 只给已经结束的(完成 / 退回):点了马上清掉
    const canClear = (item: HubHandoff) => ENDED.includes(item.status)

    if (e.surface === 'desktop') {
      const { Box, Svg, Text, Button, Select, Input } = $.ui.resolve(e)
      const busy = all.filter(one => one.state === 'busy').map(one => one.name)
      const top = boardSvg(all, me, ago, elapsed, { project: board.project, usage, duties: dutiesOf(board) })
      const options = [
        ...Object.keys(board.departments).map(one => ({ value: one, label: one })),
        { value: NEW_DEPARTMENT, label: '新部门…' },
      ]
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          {!self.name && (
            <Box key="join" flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderColor="warning" paddingX={1} marginBottom={1}>
              <Text color="warning">这个窗口还没加入</Text>
              <Select
                key="pane-join"
                label="选部门"
                options={options}
                onSelect={value =>
                  void (value === NEW_DEPARTMENT
                    ? $.prompt.fill({ text: '/hub-name 部门名称 | 一句话分工', mode: 'replace' }).catch(() => undefined)
                    : setName($, value))
                }
              />
            </Box>
          )}
          {/* 等你决定:点一个选项、或者写一句回答;已经在聊天里答过就点「已回答」 */}
          {asked.map(item => (
            <Box key={`d-${item.id}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginBottom={1}>
              <Text bold color="warning">
                {item.from} 等你决定 · {ago(item.createdAt)}
              </Text>
              <Text bold>{item.question}</Text>
              {item.context ? <Text dimColor>{clip(item.context.replace(/\s+/g, ' '), 140)}</Text> : ''}
              {item.options.length > 0 && (
                <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
                  {item.options.map((option, index) => (
                    <Button key={`d-${item.id}-${index}`} variant={index === 0 ? 'primary' : 'secondary'} onPress={() => answerDecision($, item.id, option)}>
                      {option}
                    </Button>
                  ))}
                </Box>
              )}
              <Box flexDirection="row" gap={1} marginTop={1} alignItems="center">
                {Input !== undefined ? (
                  <Input
                    key={`d-${item.id}-text`}
                    placeholder={item.options.length > 0 ? '或者写你的回答…' : '写你的回答…'}
                    submitLabel="回答"
                    onSubmit={value => void answerDecision($, item.id, value)}
                  />
                ) : (
                  ''
                )}
                <Button key={`d-${item.id}-closed`} plain dimColor label="已在聊天里回答" onPress={() => closeDecision($, item.id)} />
              </Box>
            </Box>
          ))}
          {waiting.map(item => (
            <Box key={`w-${item.id}`} flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} marginBottom={1}>
              <Text bold color="warning">
                {item.from} 交接给你
              </Text>
              <Text bold>{item.title}</Text>
              <Text dimColor>{clip(item.body.replace(/\s+/g, ' '), 120)}</Text>
              <Box flexDirection="row" gap={1} marginTop={1}>
                <Button key={`ok-${item.id}`} variant="primary" onPress={() => accept(item)}>
                  接手，开始做
                </Button>
                <Button key={`no-${item.id}`} onPress={() => decline(item)}>
                  退回
                </Button>
              </Box>
            </Box>
          ))}
          <Svg
            source={top.source}
            alt={`${board.project} 指挥台:${all.length} 个部门,工作中:${busy.join('、') || '无'}`}
          />
          {offline.length > 0 && <Svg source={sectionSvg('离线', offline.length)} alt={`离线 ${offline.length} 个部门`} />}
          {offline.map(one => (
            <Box key={`off-${one.sessionId}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" alignItems="center" gap={1}>
                <Svg source={offlineCardSvg(one, ago(one.at), W - 36, dutiesOf(board)[one.name])} alt={`${one.name} 离线`} />
                <Button key={`off-x-${one.sessionId}`} plain label="×" onPress={() => update($, removing, () => one.sessionId)} />
              </Box>
              {pendingRemove === one.sessionId && (
                <Box flexDirection="row" gap={1} alignItems="center" paddingX={1}>
                  <Button key={`off-hide-${one.sessionId}`} variant="primary" onPress={() => hideCard($, one.sessionId)}>
                    只收起卡片
                  </Button>
                  <Button key={`off-drop-${one.sessionId}`} onPress={() => removeDepartment($, one.sessionId, one.name)}>
                    连部门一起删
                  </Button>
                  <Button key={`off-cancel-${one.sessionId}`} plain dimColor label="取消" onPress={() => update($, removing, () => '')} />
                </Box>
              )}
            </Box>
          ))}
          <Svg source={sectionSvg('交接队列', open)} alt={`交接队列 ${open} 条未了结`} />
          {shown.length === 0 && <Svg source={emptyQueueSvg()} alt="还没有交接" />}
          {shown.map(item => (
            <Box key={`q-${item.id}`} flexDirection="row" alignItems="center" gap={1} marginBottom={1}>
              <Svg
                source={handoffRowSvg(item, isMine(item, self), ago(item.updatedAt), W - 36)}
                alt={`${item.from} 交接给 ${item.to}:${item.title}`}
              />
              {canClear(item) ? (
                <Button key={`x-${item.id}`} plain label="×" onPress={() => clearHandoff($, item)} />
              ) : (
                ''
              )}
            </Box>
          ))}
        </Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {!self.name && <Text color="warning">这个窗口还没加入指挥台:输入 /hub-name 部门名称 | 一句话分工</Text>}
        {asked.map(item => (
          <Box key={`d-${item.id}`} flexDirection="column" marginBottom={1}>
            <Text bold color="warning">
              {item.from} 等你决定:{item.question}
            </Text>
            <Box flexDirection="row" gap={1}>
              {item.options.map((option, index) => (
                <Button key={`d-${item.id}-${index}`} onPress={() => answerDecision($, item.id, option)}>
                  {option}
                </Button>
              ))}
              <Button key={`d-${item.id}-closed`} plain label="已在聊天里回答" onPress={() => closeDecision($, item.id)} />
            </Box>
          </Box>
        ))}
        {waiting.map(item => (
          <Box key={`w-${item.id}`} flexDirection="column" marginBottom={1}>
            <Text bold color="warning">
              {item.from} 交接给你：{item.title}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key={`ok-${item.id}`} variant="primary" onPress={() => accept(item)}>
                接手
              </Button>
              <Button key={`no-${item.id}`} onPress={() => decline(item)}>
                退回
              </Button>
            </Box>
          </Box>
        ))}
        <Text bold>{board.project} 指挥台</Text>
        {all.length === 0 && <Text dimColor>还没有部门加入。</Text>}
        {all.map(one => (
          <Box key={`d-${one.sessionId}`} flexDirection="column" marginTop={1}>
            <Text dimColor={one.state === 'offline'}>
              <Text color={one.state === 'busy' ? 'success' : undefined} bold>
                {one.state === 'busy' ? '● 工作中' : one.state === 'idle' ? '○ 空闲' : '— 离线'}
              </Text>
              {'  '}
              <Text bold>{one.name}</Text>
              {one.sessionId === me ? <Text dimColor>（本窗口）</Text> : ''}
            </Text>
            <Text dimColor>
              {'   '}
              {one.last || '—'} · {ago(one.at)}
              {one.plan ? ` · ${one.plan.done}/${one.plan.total} 步` : ''}
              {one.state === 'busy' && one.since ? ` · ${elapsed(one.since)}` : ''}
            </Text>
          </Box>
        ))}
        <Text bold>交接队列</Text>
        {shown.length === 0 && <Text dimColor>还没有交接。</Text>}
        {shown.map(item => (
          <Box key={`q-${item.id}`} flexDirection="row" gap={1}>
            <Text>
              {item.from} → {item.to}:{item.title}
            </Text>
            {canClear(item) ? (
              <Button key={`x-${item.id}`} plain label="×" onPress={() => clearHandoff($, item)} />
            ) : (
              ''
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

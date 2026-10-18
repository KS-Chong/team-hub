import { expect, mock, test } from 'claude-code/testing'

const ROOT = 'C:/proj'
const BOARD = 'C:/home/.claude/team-hub/boards/C-proj'
const DIR = `${BOARD}/status`
const QUEUE = `${BOARD}/queue`
const ME = 'sess-me-123456'
const norm = (p: string) => p.split('\\').join('/')

const PANE_PROPS = { title: 'proj 指挥台', isFocused: false, bodyColumns: 60, placement: 'dock' } as any
const COMPOSE = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], tools: [], outputStyle: null, traits: [] } as any
const BAND = { hasSurvey: false, isWorking: false, maxRows: 2 } as any

type Setup = { board?: boolean; departments?: Record<string, string>; usage?: unknown[]; root?: string }

// 一个假的磁盘 + 引擎底层:session、env、额度、提示框、通知
const setup = (on: any, options: Setup = {}) => {
  const files = new Map<string, string>()
  const prompts: string[] = []
  const filled: string[] = []
  const opened: string[] = []
  const toasts: string[] = []
  const notices: string[] = []
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/home' })
  on('session.id', () => ({ value: ME }))
  on('session.root', () => ({ value: options.root ?? ROOT }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: options.usage ?? [] } }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => {
    files.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({
    value: files.has(norm(e.path)) || [...files.keys()].some(p => p.startsWith(`${norm(e.path)}/`)),
  }))
  on('fs.list', (_$: unknown, e: { path: string }) => {
    const dir = `${norm(e.path)}/`
    return {
      value: [...files.keys()]
        .filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
        .map(p => ({ name: p.slice(dir.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.read', (_$: unknown, e: { path: string }) => {
    // 插件自己的版本文件:测试里放在 VERSION_FILE 这一格
    const path = norm(e.path)
    const text = files.get(path) ?? (path.endsWith('/hooks/version.ts') ? files.get('VERSION_FILE') : undefined)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('tool.call', () => ({ result: {}, text: 'ok' }) as any)
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    prompts.push(e.text)
    return { text: e.text } as any
  })
  on('prompt.fill', (_$: unknown, e: { text: string }) => {
    filled.push(e.text)
    return { isFilled: true } as any
  })
  on('ui.toast', (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('ui.notify', (_$: unknown, e: { text: string; title?: string }) => {
    notices.push(`${e.title ?? ''}|${e.text}`)
    return { value: { isSent: false, reason: 'no-surface' } } as any
  })
  on('command.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }) as any)
  on('ui.open', (_$: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as any
  })
  on('tool.register', () => ({ value: undefined }) as any)
  if (options.board !== false) {
    const departments = Object.fromEntries(Object.entries(options.departments ?? {}).map(([n, duty]) => [n, { duty }]))
    files.set(`${BOARD}/board.json`, JSON.stringify({ project: 'proj', root: ROOT, createdAt: 0, departments }))
  }
  const status = (sessionId: string, extra: Record<string, unknown>) =>
    files.set(`${DIR}/${sessionId}.json`, JSON.stringify({ sessionId, state: 'idle', last: '', at: Date.now(), seen: Date.now(), ...extra }))
  const handoff = (id: string, extra: Record<string, unknown>) =>
    files.set(
      `${QUEUE}/${id}.json`,
      JSON.stringify({ id, from: 'SQL 数据部门', fromSession: 'sess-sql', to: '代码部门', toSession: 'sess-code', title: `标题 ${id}`, body: 'b', status: 'waiting', createdAt: Date.now(), updatedAt: Date.now(), ...extra }),
    )
  const mine = () => JSON.parse(files.get(`${DIR}/${ME}.json`) ?? '{}')
  const queued = (id: string) => JSON.parse(files.get(`${QUEUE}/${id}.json`) ?? '{}')
  return { files, prompts, filled, opened, toasts, notices, status, handoff, mine, queued }
}

const svgOf = (drawn: any): string => {
  const out: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'Svg') out.push(String(node.props.source))
    for (const child of node.children ?? []) walk(child)
  }
  walk(drawn)
  return out.join('\n')
}

test('没开指挥台的项目:不报到、交接工具拒绝;面板里按「开启」才建看板', async ($, on) => {
  const disk = setup(on, { board: false })
  await $.command.run({ command: 'hub-name', args: '' } as any)
  await $.tool.call({ tool: 'Edit', file_path: 'a.py', old_string: 'a', new_string: 'b' } as any)
  expect([...disk.files.keys()].some(p => p.includes('/status/'))).toBe(false)
  const refused = await $.tool.call({ tool: 'mcp__team-hub__handoff', to: 'x', title: 't', body: 'b' } as any)
  expect(JSON.stringify(refused)).toContain('没开指挥台')

  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  expect(await pane.find({ text: 'proj 还没开指挥台' })).toBeDefined()
  await pane.press({ key: 'hub-enable' } as any)
  expect(JSON.parse(disk.files.get(`${BOARD}/board.json`) ?? '{}')).toMatchObject({ project: 'proj', departments: {} })
  await pane.unmount()
})

test('加入指挥台:下拉选已有部门就接替那张卡片;新部门把 /hub-name 填进输入框;/hub-name 记下分工', async ($, on) => {
  const disk = setup(on, { departments: { 'SQL 数据部门': '数据层、同步', 代码部门: '页面' } })
  disk.status('sess-old', { name: '代码部门', seen: Date.now() - 20 * 60000, at: Date.now() - 20 * 60000 })

  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: '加入 proj 指挥台' })).toBeDefined()
  await band.select({ key: 'hub-join', value: '__new__' } as any)
  expect(disk.filled[0]).toBe('/hub-name 部门名称 | 一句话分工')
  await band.select({ key: 'hub-join', value: '代码部门' } as any)
  expect(disk.mine()).toMatchObject({ name: '代码部门', state: 'idle' })
  await band.unmount()

  // 同名的旧窗口那张卡片不再列出来
  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  const svg = svgOf(await pane.drawn())
  expect(svg.split('>代码部门</text>').length - 1).toBe(1)
  expect(svg).toContain('>页面</text>')
  await pane.unmount()

  await $.command.run({ command: 'hub-name', args: '设计部门 | 设计稿' } as any)
  expect(JSON.parse(disk.files.get(`${BOARD}/board.json`) ?? '{}').departments['设计部门']).toEqual({ duty: '设计稿' })
})

test('协作规矩由插件自带:选了部门的窗口系统提示里多一段,列出各部门分工和手上没完成的交接', async ($, on) => {
  ;(globalThis as any).__disk = setup(on, { departments: { 'SQL 数据部门': '数据层、同步', 代码部门: '页面' } })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }) as any)
  const before = await $.prompt.compose(COMPOSE)
  expect(JSON.stringify(before)).not.toContain('team-hub')
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)
  const after = (await $.prompt.compose(COMPOSE)) as any
  const section = after.sections.find((one: any) => one.id === 'team-hub')
  expect(section.scope).toBe('session')
  expect(section.text).toContain('你是「代码部门」')
  expect(section.text).toContain('- SQL 数据部门:数据层、同步')
  expect(section.text).toContain('handoff')
  expect(section.text).not.toContain('你手上还没完成的交接')

  // 已接手、还没标完成的交接,每一轮都列出来;等确认的和别人的不列
  const disk = (globalThis as any).__disk
  disk.handoff('H-acc', { to: '代码部门', toSession: 'sess-x', status: 'accepted', title: '删旧的报表页' })
  disk.handoff('H-wait', { to: '代码部门', toSession: 'sess-x', status: 'waiting', title: '还没接' })
  disk.handoff('H-other', { to: 'SQL 数据部门', toSession: 'sess-sql', status: 'accepted', title: '别人的' })
  const again = (await $.prompt.compose(COMPOSE)) as any
  const text = again.sections.find((one: any) => one.id === 'team-hub').text
  expect(text).toContain('你手上还没完成的交接')
  expect(text).toContain('H-acc:SQL 数据部门 交来的「删旧的报表页」')
  expect(text).not.toContain('H-wait')
  expect(text).not.toContain('H-other')
})

test('步骤清单照抄 AI 列的,进度条按预估平滑走;Windows 路径只留文件名', async ($, on) => {
  const disk = setup(on, { departments: { 代码部门: '' } })
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)
  await $.tool.call({ tool: 'Edit', file_path: String.raw`C:\proj\core\views.py`, old_string: 'a', new_string: 'b' } as any)
  expect(disk.mine().last).toBe('改 views.py')
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: '建表', activeForm: '建表中', status: 'completed' },
      { content: '写页面', activeForm: '写页面中', status: 'in_progress' },
      { content: '跑测试', activeForm: '跑测试中', status: 'pending' },
    ],
  } as any)
  expect(disk.mine().plan).toEqual({ done: 1, total: 3, current: '写页面中' })
  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  const svg = svgOf(await pane.drawn())
  expect(svg).toContain('第 2/3 步：写页面中')
  expect(svg).toMatch(/\d+% · (约剩|快好了|比预估久)/)
  expect(svg).toContain('attributeName="width"')
  // 卡片左边不再有工作中的竖线
  expect(svg).not.toContain('width="3" height="40"')
  await pane.unmount()
})

test('额度:标题下两条小量条,重置时间只在提示里;超过 80% 时输入框上方多一段', async ($, on) => {
  const resetsAt = new Date(Date.now() + 2 * 3600000 + 14 * 60000).toISOString()
  setup(on, {
    departments: { 代码部门: '' },
    usage: [
      { kind: 'five_hour', percentUsed: 86, resetsAt },
      { kind: 'seven_day', percentUsed: 30 },
    ],
  })
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)
  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  const svg = svgOf(await pane.drawn())
  expect(svg).toContain('>5h</text>')
  expect(svg).toContain('>86%</text>')
  expect(svg).toContain('>周</text>')
  expect(svg).toMatch(/>2h1[34]m<\/text>/)
  expect(svg).toMatch(/<title>5h 额度用了 86% · 2 小时 1[34] 分后重置<\/title>/)
  await pane.unmount()
  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: '· 5h 86%' })).toBeDefined()
  await band.unmount()
})

test('交接:写进队列;收件窗口按「接手」才提交指令;结束的可以 × 掉,1 小时后自动消失;还在进行的没有 ×', async ($, on) => {
  const disk = setup(on, { departments: { 'SQL 数据部门': '数据', 代码部门: '页面' } })
  disk.status('sess-code', { name: '代码部门' })
  disk.status('sess-sql', { name: 'SQL 数据部门' })
  await $.command.run({ command: 'hub-name', args: '设计部门' } as any)

  const bad = await $.tool.call({ tool: 'mcp__team-hub__handoff', to: '财务部门', title: 't', body: 'b' } as any)
  expect(JSON.stringify(bad)).toContain('「代码部门」(页面)')
  const good = await $.tool.call({ tool: 'mcp__team-hub__handoff', to: '代码部门', title: '版式', body: '见设计稿' } as any)
  expect(JSON.stringify(good)).toContain('收件:代码部门')
  const sentId = [...disk.files.keys()].find(p => p.startsWith(`${QUEUE}/`))!.slice(QUEUE.length + 1, -5)

  const hour = 3600000
  disk.handoff('H-in', { to: '设计部门', toSession: ME, title: '字段表' })
  disk.handoff('H-done', { status: 'done', updatedAt: Date.now() - 10 * 60000 })
  disk.handoff('H-old', { status: 'done', updatedAt: Date.now() - 2 * hour })
  disk.handoff('H-others', { status: 'waiting' })

  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  const svg = svgOf(await pane.drawn())
  expect(svg).toContain('标题 H-done')
  expect(svg).not.toContain('标题 H-old')
  expect(await pane.find({ key: 'x-H-done' })).toBeDefined()
  expect(await pane.find({ key: `x-${sentId}` })).toBeUndefined()
  expect(await pane.find({ key: 'x-H-others' })).toBeUndefined()

  await pane.press({ key: 'x-H-done' } as any)
  expect(disk.queued('H-done').clearedAt).toBeGreaterThan(0)

  expect(disk.prompts.length).toBe(0)
  await pane.press({ key: 'ok-H-in' } as any)
  expect(disk.queued('H-in').status).toBe('accepted')
  expect(disk.prompts[0]).toContain('【接手交接 H-in】来自 SQL 数据部门:字段表')
  await pane.unmount()

  const notMine = await $.tool.call({ tool: 'mcp__team-hub__handoff_done', id: 'H-others' } as any)
  expect(JSON.stringify(notMine)).toContain('不是交给这个窗口的')
  await $.tool.call({ tool: 'mcp__team-hub__handoff_done', id: 'H-in', note: '做完了' } as any)
  expect(disk.queued('H-in').status).toBe('done')
})

test('超过 3 分钟没心跳的窗口显示离线;输入框上方写谁在工作、按「指挥台」打开面板', async ($, on) => {
  const disk = setup(on, { departments: { 设计部门: '', 数据部门: '', 代码部门: '' } })
  const now = Date.now()
  disk.status('sess-gone', { name: '设计部门', at: now - 10 * 60000, seen: now - 10 * 60000 })
  disk.status('sess-busy', { name: '数据部门', state: 'busy', since: now - 60000 })
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)

  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  const svg = svgOf(await pane.drawn())
  expect(svg.slice(svg.indexOf('>设计部门<'))).toContain('>离线</text>')
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: /数据部门 \d+% · 约剩/ })).toBeDefined()
  await band.press({ key: 'hub-open' } as any)
  expect(disk.opened).toContain('team-hub')
  await band.unmount()
})

test('开在 worktree 里的新窗口:算回主项目,用同一块看板', async ($, on) => {
  const WT = `${ROOT}/.claude/worktrees/hub-1234`
  const disk = setup(on, { root: WT, departments: { 代码部门: '页面' } })
  disk.files.set(`${WT}/.git`, `gitdir: ${ROOT}/.git/worktrees/hub-1234`)
  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: '加入 proj 指挥台' })).toBeDefined()
  await band.select({ key: 'hub-join', value: '代码部门' } as any)
  expect(disk.mine()).toMatchObject({ name: '代码部门' })
  expect([...disk.files.keys()].some(p => p.includes('worktrees-hub-1234'))).toBe(false)
  await band.unmount()
})

test('插件更新了、这个窗口还在跑旧版:输入框上方提醒 /reload-plugins', async ($, on) => {
  const disk = setup(on, { departments: { 代码部门: '' } })
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)
  const before = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await before.find({ text: /指挥台已更新/ })).toBeUndefined()
  await before.unmount()
  disk.files.set('VERSION_FILE', "export const VERSION = '9.9.9'")
  await $.prompt.submit({ text: '继续' } as any)
  const after = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await after.find({ text: '指挥台已更新,请在这个窗口执行 /reload-plugins' })).toBeDefined()
  await after.unmount()
})

test('别的部门做完一轮长活:这个窗口弹提示,同一次只弹一次', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const disk = setup(on, { departments: { 代码部门: '', 'SQL 数据部门': '' } })
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)
  disk.status('sess-sql', { name: 'SQL 数据部门', lastDone: { at: Date.now(), ms: 12 * 60000, task: '建订单表' } })
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true } as any)
  await clock.advance(5000)
  expect(disk.toasts.filter(t => t.includes('SQL 数据部门 做完了:建订单表(12 分钟)')).length).toBe(1)
  await clock.advance(5000)
  expect(disk.toasts.filter(t => t.includes('SQL 数据部门 做完了')).length).toBe(1)
})

test('等你决定:登记 → 面板上点选项 → 答案送回问的那个窗口;已在聊天里回答就拿掉', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const disk = setup(on, { departments: { '设计部门': '设计稿' } })
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }) as any)
  await $.command.run({ command: 'hub-name', args: '设计部门' } as any)

  const asked = await $.tool.call({ tool: 'mcp__team-hub__ask_decision', question: '左栏分组标题用哪一版?', options: ['A', 'B', 'C'], context: '推荐 B' } as any)
  expect(JSON.stringify(asked)).toContain('已登记到「等你决定」')
  expect(disk.notices.some(n => n.startsWith('设计部门 等你决定|左栏分组标题用哪一版?'))).toBe(true)
  const path = [...disk.files.keys()].find(p => p.startsWith(`${BOARD}/decisions/`))!
  const id = path.slice(`${BOARD}/decisions/`.length, -5)

  const rules = ((await $.prompt.compose(COMPOSE)) as any).sections.find((one: any) => one.id === 'team-hub').text
  expect(rules).toContain(`${id}:左栏分组标题用哪一版?`)

  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: '设计部门 等你决定:左栏分组标题用哪一版?' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  expect(await pane.find({ text: '左栏分组标题用哪一版?' })).toBeDefined()
  expect(await pane.find({ text: '推荐 B' })).toBeDefined()
  await pane.press({ key: `d-${id}-1` } as any)
  await pane.unmount()
  expect(JSON.parse(disk.files.get(path)!)).toMatchObject({ status: 'answered', answer: 'B' })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true } as any)
  await clock.advance(5000)
  expect(JSON.parse(disk.files.get(path)!).status).toBe('delivered')
  expect(disk.prompts.filter(p => p.startsWith(`【老板的决定 ${id}】`)).length).toBe(1)
  expect(disk.prompts.find(p => p.startsWith('【老板的决定'))).toContain('老板选:B')
  await clock.advance(5000)
  expect(disk.prompts.filter(p => p.startsWith('【老板的决定')).length).toBe(1)

  // 第二个问题:老板在聊天里答了,AI 用 close_decision 拿掉
  await $.tool.call({ tool: 'mcp__team-hub__ask_decision', question: '要不要画手机版?' } as any)
  const second = [...disk.files.keys()].find(p => p.startsWith(`${BOARD}/decisions/`) && p !== path)!
  const secondId = second.slice(`${BOARD}/decisions/`.length, -5)
  await $.tool.call({ tool: 'mcp__team-hub__close_decision', id: secondId } as any)
  expect(JSON.parse(disk.files.get(second)!).status).toBe('closed')
})

test('离线卡片的 ×:只收起卡片(窗口再开工会回来),或者连部门一起删', async ($, on) => {
  const disk = setup(on, { departments: { 代码部门: '', 测试部门: '', 设计部门: '' } })
  const old = Date.now() - 10 * 60000
  disk.status('sess-test', { name: '测试部门', at: old, seen: old })
  disk.status('sess-design', { name: '设计部门', at: old, seen: old })
  await $.command.run({ command: 'hub-name', args: '代码部门' } as any)

  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  expect(svgOf(await pane.drawn())).toContain('>离线</text>')
  expect(await pane.find({ key: 'off-drop-sess-test' })).toBeUndefined()
  await pane.press({ key: 'off-x-sess-test' } as any)
  expect(await pane.find({ key: 'off-hide-sess-test' })).toBeDefined()
  await pane.press({ key: 'off-drop-sess-test' } as any)
  expect(JSON.parse(disk.files.get(`${BOARD}/board.json`)!).departments['测试部门']).toBeUndefined()

  await pane.press({ key: 'off-x-sess-design' } as any)
  await pane.press({ key: 'off-hide-sess-design' } as any)
  expect(JSON.parse(disk.files.get(`${BOARD}/board.json`)!).departments['设计部门']).toBeDefined()
  const after = svgOf(await pane.drawn())
  expect(after).not.toContain('>测试部门</text>')
  expect(after).not.toContain('>设计部门</text>')
  await pane.unmount()

  // 设计部门的窗口又开工(重新报到):卡片回来
  disk.status('sess-design', { name: '设计部门', at: Date.now(), seen: Date.now() })
  const back = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  expect(svgOf(await back.drawn())).toContain('>设计部门</text>')
  await back.unmount()
})

test('早期版本的看板(~/.claude/lighthouse-hub)照旧用;记不得部门名就从自己的卡片读回来', async ($, on) => {
  const disk = setup(on, { board: false })
  const LEGACY = 'C:/home/.claude/lighthouse-hub/boards/C-proj'
  disk.files.set(`${LEGACY}/board.json`, JSON.stringify({ project: 'proj', root: ROOT, createdAt: 0, departments: { 前端部门: '页面' } }))
  disk.files.set(`${LEGACY}/status/${ME}.json`, JSON.stringify({ sessionId: ME, name: '前端部门', state: 'idle', last: '', at: Date.now(), seen: Date.now() }))
  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true } as any)
  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'hub-open' })).toBeDefined()
  await band.unmount()
  await $.tool.call({ tool: 'Edit', file_path: 'a.py', old_string: 'a', new_string: 'b' } as any)
  expect(JSON.parse(disk.files.get(`${LEGACY}/status/${ME}.json`)!).last).toBe('改 a.py')
  expect([...disk.files.keys()].some(p => p.includes('/team-hub/'))).toBe(false)
})

test('两条以上交接在等:合成一张收起的卡片,全部接手 = 一条指令按先后放进全部内容;也能展开逐条处理', async ($, on) => {
  const disk = setup(on, { departments: { 前端部门: '', 设计部门: '' } })
  await $.command.run({ command: 'hub-name', args: '前端部门' } as any)
  const now = Date.now()
  disk.handoff('H-2', { from: '设计部门', to: '前端部门', toSession: ME, title: '补充:长度上限的排版', body: '第二条正文', createdAt: now })
  disk.handoff('H-1', { from: '设计部门', to: '前端部门', toSession: ME, title: '简报各状态', body: '第一条正文', createdAt: now - 60000 })

  const band = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ text: '设计部门 的 2 条交接等你接手' })).toBeDefined()
  await band.unmount()

  const pane = await $.ui.mount({ plugin: 'team-hub', surface: 'desktop', component: 'Pane', requestId: 'team-hub', props: PANE_PROPS })
  expect(await pane.find({ text: '设计部门 交接给你 · 2 条' })).toBeDefined()
  expect(await pane.find({ text: '1. 简报各状态' })).toBeDefined()
  expect(await pane.find({ key: 'ok-H-1' })).toBeUndefined()

  // 展开 → 逐条的按钮出来;收起 → 回到合成卡片
  await pane.press({ key: 'batch-open' } as any)
  expect(await pane.find({ key: 'ok-H-1' })).toBeDefined()
  await pane.press({ key: 'batch-close' } as any)
  expect(await pane.find({ key: 'ok-H-1' })).toBeUndefined()

  await pane.press({ key: 'ok-all' } as any)
  await pane.unmount()
  expect(disk.queued('H-1').status).toBe('accepted')
  expect(disk.queued('H-2').status).toBe('accepted')
  expect(disk.prompts.length).toBe(1)
  const text = disk.prompts[0]
  expect(text.startsWith('【一起接手 2 条交接】H-1、H-2')).toBe(true)
  expect(text.indexOf('第一条正文')).toBeLessThan(text.indexOf('第二条正文'))
  expect(text).toContain('每一条都要调用 handoff_done')
})

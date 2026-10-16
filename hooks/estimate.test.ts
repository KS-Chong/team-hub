import { expect, test } from 'claude-code/testing'

import { DEFAULT_TURN_MS, estimate, median, remainingText } from './estimate'

const base = { sessionId: 's', name: '代码部门', last: '', at: 0 }
const MIN = 60000
const T0 = 1_760_000_000_000

test('空闲没有预估', () => {
  expect(estimate({ ...base, state: 'idle' } as any, 0)).toBeUndefined()
})

test('没有清单:按过去几轮的中位数走,走到预估时 95%,超过后不到 100%', () => {
  const one = { ...base, state: 'busy', since: T0, typicalTurnMs: 10 * MIN } as any
  const half = estimate(one, T0 + 5 * MIN)!
  expect(Math.round(half.pct * 100)).toBe(48)
  expect(remainingText(half)).toBe('约剩 5 分钟')
  const late = estimate(one, T0 + 30 * MIN)!
  expect(late.isOver).toBe(true)
  expect(late.pct).toBeLessThan(0.99 + 1e-9)
  expect(remainingText(late)).toBe('比预估久')
})

test('没有历史就当 3 分钟', () => {
  const one = { ...base, state: 'busy', since: T0 } as any
  expect(estimate(one, T0 + DEFAULT_TURN_MS / 2)!.remainingMs).toBe(DEFAULT_TURN_MS / 2)
})

test('有清单:按这一轮每步平均用时估剩下几步', () => {
  // 10 分钟做完 2 步 = 每步 5 分钟;第 3 步做了 1 分钟,还剩 4 + 5 = 9 分钟
  const one = { ...base, state: 'busy', since: T0, stepMark: T0 + 10 * MIN, plan: { done: 2, total: 4, current: 'x' } } as any
  const guess = estimate(one, T0 + 11 * MIN)!
  expect(guess.remainingMs).toBe(9 * MIN)
  expect(Math.round(guess.pct * 100)).toBe(55)
  expect(remainingText(guess)).toBe('约剩 9 分钟')
})

test('中位数不被一次特别长的带偏', () => {
  expect(median([60, 70, 80, 9999])).toBe(75)
  expect(median([])).toBeUndefined()
})

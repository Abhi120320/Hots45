import { describe, expect, it } from 'vitest'
import { bboxError } from './Area'

describe('coordinate entry', () => {
  it('explains why Apply is disabled', () => {
    expect(bboxError(['76', '30', '75', '31'])).toBe('West longitude must be less than east longitude.')
    expect(bboxError(['75', '31', '76', '30'])).toBe('South latitude must be less than north latitude.')
    expect(bboxError(['75', '', '76', '31'])).toBe('Enter the south latitude.')
    expect(bboxError(['75', 'x', '76', '31'])).toMatch(/South latitude must be a number/)
    expect(bboxError(['75', '30', '190', '31'])).toMatch(/Longitudes must be between/)
    expect(bboxError(['75', '30', '76', '31'])).toBeNull()
  })
})

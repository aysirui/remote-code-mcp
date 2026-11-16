import { isStaleDeviceCredentialResponse } from '../src/gateway-client'

test('只将设备解绑接口明确的失效凭据 401 视为已解绑', () => {
  expect(isStaleDeviceCredentialResponse('/api/device/unpair', 401, '设备凭据无效')).toBe(true)
  expect(isStaleDeviceCredentialResponse('/api/device/unpair', 401, 'Unauthorized')).toBe(false)
  expect(isStaleDeviceCredentialResponse('/api/device/unpair', 403, '设备凭据无效')).toBe(false)
  expect(isStaleDeviceCredentialResponse('/api/device/pairing/complete', 401, '设备凭据无效')).toBe(
    false,
  )
  expect(isStaleDeviceCredentialResponse('/api/device/unpair', undefined, undefined)).toBe(false)
})

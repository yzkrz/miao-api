/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Row } from '@tanstack/react-table'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type { User } from '../../types'
import { DataTableRowActions } from '../data-table-row-actions'
import { UsersMutateDrawer } from '../users-mutate-drawer'
import { UsersProvider } from '../users-provider'

const target: User = {
  id: 2,
  username: 'managed-admin',
  display_name: 'Managed admin',
  role: 10,
  status: 1,
  quota: 0,
  used_quota: 0,
  request_count: 0,
  group: 'default',
}
const label = "View other accounts' audit logs"
const description = 'View user and admin audit records.'

function renderPermissions(viewerRole: number, allowed?: boolean) {
  useAuthStore
    .getState()
    .auth.setUser({ id: 1, username: 'operator', role: viewerRole })
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/authz/catalog') {
      return {
        data: {
          success: true,
          data: {
            resources: [
              {
                resource: 'audit',
                label_key: 'Audit Logs',
                actions: [
                  {
                    action: 'read',
                    label_key: label,
                    description_key: description,
                  },
                ],
              },
            ],
            roles: [{ key: 'admin', grants: { audit: { read: false } } }],
          },
        },
      }
    }
    if (url === '/api/group/') {
      return { data: { success: true, data: ['default'] } }
    }
    if (url === '/api/verify/methods') {
      return {
        data: {
          success: true,
          data: {
            scope: 'admin.user.update',
            methods: [{ method: '2fa', available: true }],
            oauth_providers: [],
            password_encryption_enabled: false,
          },
        },
      }
    }
    return {
      data: {
        success: true,
        data: {
          ...target,
          admin_permissions:
            allowed === undefined ? {} : { audit: { read: allowed } },
        },
      },
    }
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <UsersProvider>
        <UsersMutateDrawer
          open
          onOpenChange={() => undefined}
          currentRow={target}
        />
      </UsersProvider>
    </QueryClientProvider>
  )
  return get
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAuthStore.getState().auth.reset()
})

it.each([undefined, true])(
  'root can save an audit grant or revocation after step-up verification (previous=%s)',
  async (allowed) => {
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true } })
    vi.spyOn(api, 'post').mockResolvedValue({
      data: {
        success: true,
        data: {
          proof_token: 'update-proof',
          method: '2fa',
          scope: 'admin.user.update',
          expires_at: Math.floor(Date.now() / 1000) + 60,
        },
      },
    })
    renderPermissions(100, allowed)
    await screen.findByDisplayValue('Managed admin')
    const toggle = await screen.findByRole('button', { name: label })
    await waitFor(() =>
      expect(toggle).toHaveAttribute('aria-pressed', String(!!allowed))
    )
    expect(toggle).toHaveAccessibleDescription(description)
    await userEvent.click(toggle)
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    // The permission matrix changed, so the save waits for verification.
    expect(put).not.toHaveBeenCalled()
    await userEvent.type(
      await screen.findByLabelText('Authenticator code or backup code'),
      '123456'
    )
    await userEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        '/api/user/',
        expect.objectContaining({
          id: 2,
          admin_permissions: { audit: { read: !allowed } },
        }),
        expect.objectContaining({
          headers: { 'X-Security-Proof': 'update-proof' },
          singleUseAuthorization: true,
        })
      )
    )
  }
)

it('root saving an administrator without changing permissions or password does not verify', async () => {
  const put = vi
    .spyOn(api, 'put')
    .mockResolvedValue({ data: { success: true } })
  const get = renderPermissions(100, true)
  const displayName = await screen.findByDisplayValue('Managed admin')
  await userEvent.clear(displayName)
  await userEvent.type(displayName, 'Renamed admin')
  await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith(
      '/api/user/',
      expect.objectContaining({ id: 2, display_name: 'Renamed admin' }),
      {}
    )
  )
  expect(put.mock.calls[0][1]).not.toHaveProperty('admin_permissions')
  expect(get).not.toHaveBeenCalledWith('/api/verify/methods', expect.anything())
})

it('admin cannot edit the audit permission even when the catalog is available', async () => {
  renderPermissions(10)
  await screen.findByDisplayValue('Managed admin')
  expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
})

it.each([
  { viewer: 10, targetRole: 10, targetId: 2, granted: true, allowed: true },
  { viewer: 10, targetRole: 10, targetId: 1, granted: true, allowed: true },
  { viewer: 10, targetRole: 100, targetId: 2, granted: true, allowed: false },
  { viewer: 10, targetRole: 10, targetId: 2, granted: false, allowed: true },
  { viewer: 10, targetRole: 10, targetId: 1, granted: false, allowed: true },
  { viewer: 10, targetRole: 1, targetId: 2, granted: false, allowed: true },
  { viewer: 100, targetRole: 10, targetId: 2, granted: false, allowed: true },
  { viewer: 1, targetRole: 1, targetId: 2, granted: true, allowed: false },
  { viewer: 100, targetRole: 100, targetId: 1, granted: false, allowed: true },
])(
  'quota, limits and keys menus follow administrator roles: %j',
  async (testCase) => {
    useAuthStore.getState().auth.setUser({
      id: 1,
      username: 'operator',
      role: testCase.viewer,
      permissions: { admin_permissions: { audit: { read: testCase.granted } } },
    })
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: useAuthStore.getState().auth.user },
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <UsersProvider>
          <DataTableRowActions
            row={
              {
                original: {
                  ...target,
                  id: testCase.targetId,
                  role: testCase.targetRole,
                },
              } as Row<User>
            }
          />
        </UsersProvider>
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    const item = await screen.findByRole('menuitem', { name: 'Usage Limits' })
    if (testCase.allowed) {
      expect(item).not.toHaveAttribute('aria-disabled', 'true')
    } else {
      expect(item).toHaveAttribute('aria-disabled', 'true')
    }
    const keys = screen.getByRole('menuitem', { name: 'Key management' })
    const canManageKeys =
      testCase.viewer >= 10 &&
      (testCase.targetRole < 100 || testCase.viewer === 100)
    if (canManageKeys) {
      expect(keys).not.toHaveAttribute('aria-disabled', 'true')
    } else {
      expect(keys).toHaveAttribute('aria-disabled', 'true')
    }
    const quota = screen.getByRole('menuitem', { name: 'Adjust Quota' })
    expect(quota.getAttribute('aria-disabled') === 'true').toBe(
      !testCase.allowed
    )
  }
)

it.each([
  { id: 2, role: 10, name: 'peer administrator' },
  { id: 3, role: 1, name: 'ordinary user' },
  { id: 1, role: 10, name: 'self' },
])(
  'allows an administrator without an audit grant to edit limits for $name',
  async (targetUser) => {
    const user = userEvent.setup()
    const operator = {
      id: 1,
      username: 'operator',
      role: 10,
      permissions: { admin_permissions: { audit: { read: false } } },
    }
    useAuthStore.getState().auth.setUser(operator)
    const limits = {
      max_concurrency: 2,
      current_concurrency: 0,
      updated_at: 0,
      usage_rules: [],
    }
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/user/self') {
        return {
          data: {
            success: true,
            data: {
              ...operator,
              permissions: { admin_permissions: { audit: { read: false } } },
            },
          },
        }
      }
      return {
        data: {
          success: true,
          data: String(url).endsWith('/models') ? [] : limits,
        },
      }
    })
    const put = vi
      .spyOn(api, 'put')
      .mockResolvedValue({ data: { success: true, data: limits } })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <UsersProvider>
          <DataTableRowActions
            row={
              {
                original: {
                  ...target,
                  id: targetUser.id,
                  role: targetUser.role,
                },
              } as Row<User>
            }
          />
        </UsersProvider>
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Open menu' }))
    const item = await screen.findByRole('menuitem', { name: 'Usage Limits' })
    await waitFor(() =>
      expect(item).not.toHaveAttribute('aria-disabled', 'true')
    )
    expect(get).toHaveBeenCalledWith('/api/user/self', expect.anything())
    await user.click(item)
    const concurrency = await screen.findByRole('spinbutton', {
      name: 'Maximum concurrency',
    })
    fireEvent.change(concurrency, { target: { value: '4' } })
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    await user.type(screen.getByRole('spinbutton', { name: /Quota/ }), '3')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        `/api/user/${targetUser.id}/limits`,
        expect.objectContaining({
          max_concurrency: 4,
          usage_rules: [
            expect.objectContaining({ window_seconds: 18000, enabled: true }),
          ],
        })
      )
    )
    client.clear()
  }
)

it.each([
  { viewer: 10, targetId: 2, targetRole: 10 },
  { viewer: 10, targetId: 1, targetRole: 10 },
  { viewer: 100, targetId: 1, targetRole: 100 },
])(
  'adjusts quota from the menu without opening account settings: %j',
  async (testCase) => {
    const user = userEvent.setup()
    const operator = { id: 1, username: 'operator', role: testCase.viewer }
    useAuthStore.getState().auth.setUser(operator)
    vi.spyOn(api, 'get').mockResolvedValue({
      data: { success: true, data: operator },
    })
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ data: { success: true } })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <UsersProvider>
          <DataTableRowActions
            row={
              {
                original: {
                  ...target,
                  id: testCase.targetId,
                  role: testCase.targetRole,
                },
              } as Row<User>
            }
          />
        </UsersProvider>
      </QueryClientProvider>
    )
    await user.click(screen.getByRole('button', { name: 'Open menu' }))
    await user.click(screen.getByRole('menuitem', { name: 'Adjust Quota' }))
    fireEvent.change(await screen.findByRole('spinbutton'), {
      target: { value: '1' },
    })
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/user/manage', {
        id: testCase.targetId,
        action: 'add_quota',
        mode: 'add',
        value: 500000,
      })
    )
    client.clear()
  }
)

it.each(['demoted role', 'changed account'] as const)(
  'does not keep stale permission after %s while refreshing the menu',
  async (scenario) => {
    const operator = {
      id: 1,
      username: 'operator',
      role: 10,
      permissions: { admin_permissions: { audit: { read: true } } },
    }
    useAuthStore.getState().auth.setUser(operator)
    let finish!: (result: {
      data: { success: boolean; data: typeof operator }
    }) => void
    vi.spyOn(api, 'get').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <UsersProvider>
          <DataTableRowActions row={{ original: target } as Row<User>} />
        </UsersProvider>
      </QueryClientProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    await waitFor(() => expect(finish).toBeDefined())
    await act(async () => {
      if (scenario === 'changed account') {
        useAuthStore
          .getState()
          .auth.setUser({ id: 3, username: 'other-user', role: 1 })
      }
      finish({
        data: {
          success: true,
          data: {
            ...operator,
            role: scenario === 'demoted role' ? 1 : operator.role,
            permissions: {
              admin_permissions: {
                audit: { read: scenario === 'changed account' },
              },
            },
          },
        },
      })
    })
    await waitFor(() =>
      expect(
        screen.getByRole('menuitem', { name: 'Usage Limits' })
      ).toHaveAttribute('aria-disabled', 'true')
    )
    expect(useAuthStore.getState().auth.user?.id).toBe(
      scenario === 'changed account' ? 3 : 1
    )
    client.clear()
  }
)

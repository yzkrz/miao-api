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
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { UserApiKeysDrawer } from '@/features/users/components/dialogs/user-api-keys-drawer'
import { api } from '@/lib/api'

import {
  batchDeleteApiKeys,
  createApiKey,
  createManagedApiKeys,
  deleteApiKey,
  fetchTokenKey,
  fetchTokenKeysBatch,
  updateApiKey,
  updateApiKeyStatus,
  type ApiKeysScope,
} from '../../api'
import { apiKeySchema, type ApiKeyFormData } from '../../types'

const clients: QueryClient[] = []
const payload: ApiKeyFormData = {
  name: 'managed',
  expired_time: -1,
  remain_quota: 0,
  unlimited_quota: true,
  model_limits_enabled: false,
  model_limits: '',
  allow_ips: '',
  group: 'default',
  cross_group_retry: false,
  allow_user_quota_query: true,
  auto_groups: [],
}

afterEach(() => {
  cleanup()
  clients.splice(0).forEach((client) => client.clear())
  vi.restoreAllMocks()
})

it.each([
  {
    action: 'create',
    ids: [],
    count: 1,
    method: 'post',
    path: '/',
    data: payload,
    run: (scope: ApiKeysScope) => createApiKey(payload, scope),
  },
  {
    action: 'create',
    ids: [],
    count: 2,
    method: 'post',
    path: '/batch/create',
    data: { tokens: [payload, payload] },
    run: (scope: ApiKeysScope) =>
      createManagedApiKeys([payload, payload], scope),
  },
  {
    action: 'update',
    ids: [9],
    count: 0,
    method: 'put',
    path: '/',
    data: { ...payload, id: 9 },
    run: (scope: ApiKeysScope) => updateApiKey({ ...payload, id: 9 }, scope),
  },
  {
    action: 'status',
    ids: [9],
    count: 0,
    method: 'put',
    path: '/?status_only=true',
    data: { id: 9, status: 2 },
    run: (scope: ApiKeysScope) => updateApiKeyStatus(9, 2, scope),
  },
  {
    action: 'delete',
    ids: [9],
    count: 0,
    method: 'delete',
    path: '/9/',
    run: (scope: ApiKeysScope) => deleteApiKey(9, scope),
  },
  {
    action: 'delete_batch',
    ids: [9, 10],
    count: 0,
    method: 'post',
    path: '/batch',
    data: { ids: [10, 9] },
    run: (scope: ApiKeysScope) => batchDeleteApiKeys([10, 9], scope),
  },
  {
    action: 'reveal',
    ids: [9],
    count: 0,
    method: 'post',
    path: '/9/key',
    data: undefined,
    run: (scope: ApiKeysScope) => fetchTokenKey(9, scope),
  },
  {
    action: 'reveal_batch',
    ids: [9, 10],
    count: 0,
    method: 'post',
    path: '/batch/keys',
    data: { ids: [10, 9] },
    run: (scope: ApiKeysScope) => fetchTokenKeysBatch([10, 9], scope),
  },
] as const)(
  'binds $action $path to the owner and a fresh operation proof',
  async (testCase) => {
    const authorize = vi.fn().mockResolvedValue('operation-proof')
    const scope = { userId: 42, authorize }
    const request = vi
      .spyOn(api, testCase.method)
      .mockResolvedValue({ data: { success: true, data: {} } })
    await testCase.run(scope)
    expect(authorize).toHaveBeenCalledWith(
      testCase.action,
      [...testCase.ids],
      testCase.count
    )
    const options = { headers: { 'X-Security-Proof': 'operation-proof' } }
    if (testCase.method === 'delete') {
      expect(request).toHaveBeenCalledWith(
        `/api/user/42/tokens${testCase.path}`,
        options
      )
    } else {
      expect(request).toHaveBeenCalledWith(
        `/api/user/42/tokens${testCase.path}`,
        testCase.data,
        options
      )
    }
  }
)

it('does not send an administrative write when verification is cancelled', async () => {
  const post = vi.spyOn(api, 'post')
  await expect(
    createApiKey(payload, { userId: 42, authorize: async () => null })
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(post).not.toHaveBeenCalled()
})

it.each([
  {
    method: 'password',
    label: 'Password',
    value: 'admin-password',
    fields: { password: 'admin-password' },
  },
  {
    method: '2fa',
    label: 'Authenticator code or backup code',
    value: '123456',
    fields: { code: '123456' },
  },
])(
  'verifies $method above the nested create drawer before creating keys for the target user',
  async (testCase) => {
    const user = userEvent.setup()
    vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url === '/api/status') return { data: { success: true, data: {} } }
      if (url === '/api/verify/methods') {
        return {
          data: {
            success: true,
            data: {
              scope: 'admin.user.tokens',
              methods: [{ method: testCase.method, available: true }],
              oauth_providers: [],
              password_encryption_enabled: false,
            },
          },
        }
      }
      if (url.endsWith('/groups')) {
        return {
          data: {
            success: true,
            data: { default: { desc: 'Default', ratio: 1 } },
          },
        }
      }
      if (url.endsWith('/models')) return { data: { success: true, data: [] } }
      if (url.endsWith('/auto-groups')) {
        return {
          data: { success: true, data: { groups: ['default'], max_count: 3 } },
        }
      }
      if (url.startsWith('/api/user/42/tokens/')) {
        return { data: { success: true, data: { items: [], total: 0 } } }
      }
      throw new Error(`Unexpected GET ${url}`)
    })
    const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
      if (url === '/api/verify') {
        return {
          data: {
            success: true,
            data: {
              proof_token: 'fresh-proof',
              scope: 'admin.user.tokens',
              method: testCase.method,
              expires_at: 2000000000,
            },
          },
        }
      }
      if (url === '/api/user/42/tokens/batch/create') {
        return { data: { success: true, data: { count: 1 } } }
      }
      throw new Error(`Unexpected POST ${url}`)
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    clients.push(client)
    render(
      <QueryClientProvider client={client}>
        <UserApiKeysDrawer
          open
          onOpenChange={() => {}}
          user={{ id: 42, username: 'owner-42' }}
        />
      </QueryClientProvider>
    )
    await user.click(
      await screen.findByRole('button', { name: 'Create API Key' })
    )
    const createDrawer = await screen.findByRole('dialog', {
      name: 'Create API Key',
    })
    const save = within(createDrawer).getByRole('button', {
      name: 'Save changes',
    })
    await waitFor(() => expect(save).toBeEnabled())
    await user.type(
      within(createDrawer).getByRole('textbox', { name: 'Name' }),
      'protected-key'
    )
    await user.click(save)

    let verification = await screen.findByRole('dialog', {
      name: 'Verify API key management',
    })
    let input = await within(verification).findByLabelText(testCase.label, {
      selector: 'input',
    })
    await waitFor(() => expect(input).toHaveFocus())
    expect(post).not.toHaveBeenCalled()
    await user.click(
      within(verification).getByRole('button', { name: 'Cancel' })
    )
    await waitFor(() => expect(save).toBeEnabled())
    expect(
      within(createDrawer).getByRole('textbox', { name: 'Name' })
    ).toHaveValue('protected-key')
    expect(post).not.toHaveBeenCalled()

    await user.click(save)
    verification = await screen.findByRole('dialog', {
      name: 'Verify API key management',
    })
    input = await within(verification).findByLabelText(testCase.label, {
      selector: 'input',
    })
    await user.type(input, testCase.value)
    await user.click(
      within(verification).getByRole('button', { name: 'Verify' })
    )
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/user/42/tokens/batch/create',
        {
          tokens: [
            expect.objectContaining({
              name: 'protected-key',
              group: '',
            }),
          ],
        },
        { headers: { 'X-Security-Proof': 'fresh-proof' } }
      )
    )
    expect(post).toHaveBeenCalledWith(
      '/api/verify',
      {
        method: testCase.method,
        scope: 'admin.user.tokens',
        context: { user_id: 42, action: 'create', token_ids: [], count: 1 },
        ...testCase.fields,
      },
      expect.anything()
    )
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Create API Key' })
      ).not.toBeInTheDocument()
    )
    expect(screen.getByRole('dialog', { name: 'Key management' })).toBeVisible()
  }
)

it('reuses the keys page inside a drawer with owner-scoped search, metadata and disclosure', async () => {
  const user = userEvent.setup()
  const key = apiKeySchema.parse({
    id: 9,
    name: 'owner-42-key',
    key: 'masked-key',
    status: 1,
    expired_time: -1,
    unlimited_quota: true,
    group: 'customer',
    remain_quota: 0,
    used_quota: 0,
    created_time: 0,
    accessed_time: 0,
    model_limits_enabled: false,
  })
  const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === '/api/status') return { data: { success: true, data: {} } }
    if (url === '/api/verify/methods') {
      return {
        data: {
          success: true,
          data: {
            scope: 'admin.user.tokens',
            methods: [{ method: 'session', available: true }],
            oauth_providers: [],
            password_encryption_enabled: false,
          },
        },
      }
    }
    if (url.endsWith('/groups')) {
      return {
        data: {
          success: true,
          data: { customer: { desc: 'Customer', ratio: 2 } },
        },
      }
    }
    if (url.endsWith('/models')) {
      return { data: { success: true, data: ['customer-model'] } }
    }
    if (url.endsWith('/auto-groups')) {
      return {
        data: { success: true, data: { groups: ['customer'], max_count: 3 } },
      }
    }
    if (url.startsWith('/api/user/42/tokens/')) {
      return { data: { success: true, data: { items: [key], total: 1 } } }
    }
    if (url.startsWith('/api/user/43/tokens/')) {
      return {
        data: {
          success: true,
          data: { items: [{ ...key, name: 'owner-43-key' }], total: 1 },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url) => {
    if (url === '/api/verify') {
      return {
        data: {
          success: true,
          data: {
            proof_token: 'fresh-proof',
            scope: 'admin.user.tokens',
            method: 'session',
            expires_at: 2000000000,
          },
        },
      }
    }
    if (url === '/api/user/42/tokens/9/key') {
      return { data: { success: true, data: { key: 'owner-42-secret' } } }
    }
    if (url === '/api/user/43/tokens/9/key') {
      return { data: { success: true, data: { key: 'owner-43-secret' } } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(client)
  const renderDrawer = (id: number) => (
    <QueryClientProvider client={client}>
      <UserApiKeysDrawer
        open
        onOpenChange={() => {}}
        user={{ id, username: `owner-${id}` }}
      />
    </QueryClientProvider>
  )
  const view = render(renderDrawer(42))
  await screen.findByText('owner-42-key')
  expect(get).toHaveBeenCalledWith('/api/user/42/tokens/?p=1&size=20')
  expect(get).toHaveBeenCalledWith('/api/user/42/tokens/groups')
  await user.type(
    screen.getByPlaceholderText('Filter by name...'),
    'production'
  )
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      '/api/user/42/tokens/search?keyword=production&p=1&size=20'
    )
  )
  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Copy Key' }))
  await waitFor(() => expect(copy).toHaveBeenCalledWith('sk-owner-42-secret'))
  expect(post).toHaveBeenCalledWith(
    '/api/verify',
    expect.objectContaining({
      scope: 'admin.user.tokens',
      context: { user_id: 42, action: 'reveal', token_ids: [9], count: 0 },
    }),
    expect.anything()
  )
  expect(post).toHaveBeenCalledWith('/api/user/42/tokens/9/key', undefined, {
    headers: { 'X-Security-Proof': 'fresh-proof' },
  })
  await user.click(screen.getByRole('button', { name: 'Create API Key' }))
  const createDrawer = await screen.findByRole('dialog', {
    name: 'Create API Key',
  })
  await waitFor(() =>
    expect(
      within(createDrawer).getByRole('button', { name: 'Save changes' })
    ).toBeEnabled()
  )
  expect(get).toHaveBeenCalledWith('/api/user/42/tokens/models')
  expect(get).toHaveBeenCalledWith('/api/user/42/tokens/auto-groups')
  view.rerender(renderDrawer(43))
  await screen.findByText('owner-43-key')
  expect(screen.queryByText('owner-42-key')).not.toBeInTheDocument()
  expect(
    screen.queryByRole('dialog', { name: 'Create API Key' })
  ).not.toBeInTheDocument()
  expect(screen.getByPlaceholderText('Filter by name...')).toHaveValue('')
  await user.click(screen.getByRole('button', { name: 'Open menu' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Copy Key' }))
  await waitFor(() => expect(copy).toHaveBeenCalledWith('sk-owner-43-secret'))
  expect(
    get.mock.calls.some(
      ([url]) =>
        url.startsWith('/api/token') ||
        url === '/api/user/models' ||
        url === '/api/user/self/groups'
    )
  ).toBe(false)
})

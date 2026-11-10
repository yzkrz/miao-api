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
import { createHash, webcrypto } from 'node:crypto'

import {
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { api } from '@/lib/api'

import {
  prepareEmailDraft,
  emailDraftDigest,
  sha256,
} from '../../../lib/user-email'
import { UserEmailDrawer } from '../user-email-drawer'

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }))
vi.mock('@/features/security/hooks/use-account-security', () => ({
  useAccountSecurity: () => ({
    pending: false,
    showVerification: false,
    verificationDialogProps: {},
    verify,
    run: (action: (signal: AbortSignal) => Promise<unknown>) =>
      action(new AbortController().signal),
  }),
}))
vi.mock('@/features/auth/secure-verification', () => ({
  SecureVerificationDialog: () => null,
}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  verify.mockReset()
})

it('keeps the recipient readonly and binds sending to the exact subject, body and recipient', async () => {
  vi.stubGlobal('crypto', webcrypto)
  verify.mockResolvedValue('single-use-proof')
  const post = vi
    .spyOn(api, 'post')
    .mockResolvedValue({ data: { success: true } })
  const close = vi.fn()
  const user = userEvent.setup()
  render(
    <UserEmailDrawer
      open
      onOpenChange={close}
      user={{ id: 5, username: 'recipient', email: 'target@example.com' }}
    />
  )
  expect(screen.getByLabelText('Recipient')).toHaveAttribute('readonly')
  expect(screen.getByRole('button', { name: 'Send email' })).toBeDisabled()
  await user.type(screen.getByLabelText('Subject'), 'Notice')
  const editor = screen.getByRole('textbox', { name: 'Message' })
  editor.innerHTML = '<p><b>Hello</b></p>'
  fireEvent.input(editor)
  await user.click(screen.getByRole('button', { name: 'Preview' }))
  expect(screen.getAllByText('Hello')).toHaveLength(2)
  await user.click(screen.getByRole('button', { name: 'Send email' }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  const draft = { subject: 'Notice', html: '<p><b>Hello</b></p>', images: [] }
  expect(verify).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: 'admin.user.email',
      context: {
        user_id: 5,
        email: 'target@example.com',
        digest: await emailDraftDigest(draft),
      },
    }),
    expect.any(AbortSignal)
  )
  expect(post).toHaveBeenCalledWith(
    '/api/user/5/email',
    draft,
    expect.objectContaining({
      headers: { 'X-Security-Proof': 'single-use-proof' },
      singleUseAuthorization: true,
    })
  )
  expect(close).toHaveBeenCalledWith(false)
})

it('sanitizes active content and converts uploaded images to content IDs covered by the digest', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const draft = prepareEmailDraft(
    ' Title ',
    '<p onclick="alert(1)">Hello</p><script>alert(1)</script><img src="data:image/png;base64,aGVsbG8=">'
  )
  expect(draft.subject).toBe('Title')
  expect(draft.html).not.toContain('onclick')
  expect(draft.html).not.toContain('script')
  expect(draft.html).toContain('src="cid:image-1"')
  expect(draft.images).toEqual([
    { cid: 'image-1', content_type: 'image/png', content: 'aGVsbG8=' },
  ])
  const digest = await emailDraftDigest(draft)
  expect(digest).not.toBe(
    await emailDraftDigest({ ...draft, subject: 'Other' })
  )
  expect(digest).not.toBe(
    await emailDraftDigest({
      ...draft,
      images: [{ ...draft.images[0], content: 'Ynl0ZXM=' }],
    })
  )
})

it('computes the server digest when Web Crypto is unavailable on a plain HTTP origin', async () => {
  const draft = prepareEmailDraft('Notice', '<p>你好 🐷</p>')
  vi.stubGlobal('crypto', webcrypto)
  const secure = await emailDraftDigest(draft)
  vi.stubGlobal('crypto', undefined)

  await expect(emailDraftDigest(draft)).resolves.toBe(secure)
})

it.each([0, 55, 56, 64, 1000])(
  'matches Node SHA-256 for a %s-byte message across padding boundaries',
  (size) => {
    const message = new Uint8Array(size).map((_, i) => (i * 31) % 256)
    const expected = createHash('sha256').update(message).digest('hex')

    expect(Buffer.from(sha256(message)).toString('hex')).toBe(expected)
  }
)

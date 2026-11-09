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
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { logout } from '@/features/auth/api'
import { clearAuthentication, getSelf } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore, type AuthUser } from '@/stores/auth-store'

import { EmailBindDialog } from './dialogs/email-bind-dialog'

export function RequiredEmailGate(props: { children: ReactNode }) {
  const { t } = useTranslation()
  const user = useAuthStore((state) => state.auth.user)
  const [refreshing, setRefreshing] = useState(false)
  if (!user || user.role === 100 || (user.email && user.email_verified)) {
    return props.children
  }
  const refresh = async () => {
    setRefreshing(true)
    const sid = useAuthStore.getState().auth.session?.sid
    try {
      const profile = requireServerSuccess(await getSelf()).data as AuthUser
      const auth = useAuthStore.getState().auth
      if (
        profile.id === user.id &&
        auth.user?.id === user.id &&
        auth.session?.sid === sid
      ) {
        auth.setUser(profile)
      }
    } catch (error) {
      handleServerError(error)
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <main className='flex min-h-dvh flex-col items-center justify-center gap-4 p-6'>
      <p>{t('Verify your email to continue')}</p>
      <EmailBindDialog
        key={user.id}
        required
        open
        onOpenChange={() => {}}
        currentEmail={user.email}
        onSuccess={() => void refresh()}
        requiredActions={
          <>
            <Button
              variant='ghost'
              onClick={async () => {
                try {
                  await logout()
                  clearAuthentication()
                } catch (error) {
                  handleServerError(error)
                }
              }}
            >
              {t('Log out')}
            </Button>
            <Button
              variant='outline'
              disabled={refreshing}
              onClick={() => void refresh()}
            >
              {t('Refresh')}
            </Button>
          </>
        }
      />
    </main>
  )
}

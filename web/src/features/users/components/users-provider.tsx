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
import { useQueryClient } from '@tanstack/react-query'
import React, { useCallback, useMemo, useState } from 'react'

import {
  SecureVerificationDialog,
  useSecureVerification,
} from '@/features/auth/secure-verification'
import useDialogState from '@/hooks/use-dialog'
import { getSelf } from '@/lib/api'
import { handleServerError } from '@/lib/handle-server-error'
import { requireServerSuccess } from '@/lib/server-error-message'
import { useAuthStore, type AuthUser } from '@/stores/auth-store'

import type { User, UsersDialogType } from '../types'

type UsersContextType = {
  open: UsersDialogType | null
  setOpen: (str: UsersDialogType | null) => void
  currentRow: User | null
  setCurrentRow: React.Dispatch<React.SetStateAction<User | null>>
  refreshTrigger: number
  triggerRefresh: () => void
  refreshOperatorPermissions: () => Promise<void>
  /** Step-up ceremony shared by every risky user-management action. */
  requestVerification: ReturnType<
    typeof useSecureVerification
  >['requestVerification']
  /** True while the step-up dialog is showing; confirm dialogs yield to it. */
  verificationActive: boolean
}

const UsersContext = React.createContext<UsersContextType | null>(null)

export function UsersProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useDialogState<UsersDialogType>(null)
  const [currentRow, setCurrentRow] = useState<User | null>(null)
  const [refreshTrigger, setRefreshTrigger] = useState(0)
  // The dialog mounts once here; consumers only receive the proof token, and
  // the memoized value keeps dialog keystrokes from re-rendering the table.
  const verification = useSecureVerification()
  const requestVerification = verification.requestVerification
  const verificationActive = verification.isActive

  const triggerRefresh = useCallback(
    () => setRefreshTrigger((prev) => prev + 1),
    []
  )

  const refreshOperatorPermissions = useCallback(async () => {
    const auth = useAuthStore.getState().auth
    if (!auth.user) return
    const userId = auth.user.id
    const sessionId = auth.session?.sid
    try {
      const profile = await queryClient.fetchQuery({
        queryKey: ['users', 'operator-permissions', userId, sessionId],
        queryFn: async () =>
          requireServerSuccess(await getSelf()).data as AuthUser,
        staleTime: 0,
        gcTime: 0,
      })
      const current = useAuthStore.getState().auth
      // A request from an earlier login must not update the current account.
      if (
        current.user?.id !== userId ||
        current.session?.sid !== sessionId ||
        profile.id !== userId
      ) {
        return
      }
      current.setUser({
        ...current.user,
        role: profile.role,
        permissions: profile.permissions,
      })
    } catch (error) {
      handleServerError(error)
    }
  }, [queryClient])

  const value = useMemo(
    () => ({
      open,
      setOpen,
      currentRow,
      setCurrentRow,
      refreshTrigger,
      triggerRefresh,
      refreshOperatorPermissions,
      requestVerification,
      verificationActive,
    }),
    [
      open,
      setOpen,
      currentRow,
      refreshTrigger,
      triggerRefresh,
      refreshOperatorPermissions,
      requestVerification,
      verificationActive,
    ]
  )

  return (
    <UsersContext value={value}>
      {children}
      <SecureVerificationDialog {...verification.dialogProps} />
    </UsersContext>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useUsers = () => {
  const usersContext = React.useContext(UsersContext)

  if (!usersContext) {
    throw new Error('useUsers has to be used within <UsersContext>')
  }

  return usersContext
}

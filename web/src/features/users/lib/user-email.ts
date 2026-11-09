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
import DOMPurify from 'dompurify'

export interface EmailImage {
  cid: string
  content_type: string
  content: string
}
export interface UserEmailDraft {
  subject: string
  html: string
  images: EmailImage[]
}

export function prepareEmailDraft(
  subject: string,
  html: string
): UserEmailDraft {
  const template = document.createElement('template')
  template.innerHTML = DOMPurify.sanitize(html)
  const images: EmailImage[] = []
  template.content.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? ''
    const match =
      /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
        source
      )
    if (!match) return
    const cid = `image-${images.length + 1}`
    images.push({ cid, content_type: match[1], content: match[2] })
    image.setAttribute('src', `cid:${cid}`)
  })
  return { subject: subject.trim(), html: template.innerHTML, images }
}

export async function emailDraftDigest(draft: UserEmailDraft): Promise<string> {
  let content = `${draft.subject}\0${draft.html}`
  for (const image of draft.images) {
    content += `\0${image.cid}\0${image.content_type}\0${image.content}`
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(content)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

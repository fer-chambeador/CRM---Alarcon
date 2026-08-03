import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Chambas CRM',
  description: 'CRM de leads — Chambas',
  // 20-jul-2026: verificación de dominio para Google Calendar push
  // notifications. Pega en Railway el env var GOOGLE_SITE_VERIFICATION
  // con el código que da Search Console (método "etiqueta HTML").
  ...(process.env.GOOGLE_SITE_VERIFICATION
    ? { verification: { google: process.env.GOOGLE_SITE_VERIFICATION } }
    : {}),
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a12',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}

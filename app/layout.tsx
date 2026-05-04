import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Chambas CRM',
  description: 'CRM de leads — Chambas',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}

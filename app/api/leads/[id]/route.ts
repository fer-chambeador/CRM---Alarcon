import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase"

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const body = await req.json()
  const { id } = params
  const allowed = ["nombre","empresa","telefono","puesto","canal_adquisicion","status","notas","plan"]
  const updates: Record<string, unknown> = {}
  for (const key of allowed) { if (key in body) updates[key] = body[key] }
  if (body.status === "contactado" || body.incrementar_contacto) {
    const { data: lead } = await supabase.from("leads").select("veces_contactado").eq("id", id).single()
    if (lead) { updates.veces_contactado = (lead.veces_contactado || 0) + 1; updates.ultimo_contacto = new Date().toISOString() }
  }
  const { data, error } = await supabase.from("leads").update(updates).eq("id", id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (body.status) {
    await supabase.from("lead_actividad").insert({ lead_id: id, tipo: "status_change", descripcion: `Status cambiado a: ${body.status}`, metadata: updates })
  }
  return NextResponse.json(data)
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createServiceClient()
  const { id } = params
  await supabase.from("lead_actividad").delete().eq("lead_id", id)
  const { error } = await supabase.from("leads").delete().eq("id", id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
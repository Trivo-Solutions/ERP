// The payload for POST /inventory/metals. The metal is the SELECTED KARAT's own (from the company's Karat master) - the form never
// lets the user pick a metal separately - and the server re-checks it against its own copy of the master, so this is a
// convenience for a clear error, not the authority. A karat the master does not know sends no metal at all (the server refuses it).
export interface VaultKaratRef { code: string; metalType: string }
export interface MetalStockForm {
  materialName: string; karat: string; purity: number | string; grossWeight: number | string; netWeight: number | string;
  location: string; sourceType: string; avgCostPerGram: number | string;
}

export function buildMetalStockPayload(form: MetalStockForm, karats: VaultKaratRef[]) {
  const metalType = karats.find((k) => k.code === form.karat)?.metalType;
  return {
    ...form,
    metalType,
    purity: Number(form.purity), grossWeight: Number(form.grossWeight), netWeight: Number(form.netWeight), avgCostPerGram: Number(form.avgCostPerGram),
  };
}

// The form's starting values: 22K when the company has it (else its first gold karat, else the first vault karat) with that karat's own
// purity. With no karats loaded yet the karat stays blank (the form cannot be submitted until the list arrives).
export interface VaultKaratFull extends VaultKaratRef { purity: number | string }
export function emptyMetalStockForm(karats: VaultKaratFull[]): MetalStockForm {
  const first = karats.find((k) => k.code === '22K') ?? karats.find((k) => k.metalType === 'GOLD') ?? karats[0];
  return {
    materialName: '', karat: first?.code ?? '', purity: first ? Number(first.purity) : 0, grossWeight: 0, netWeight: 0,
    location: 'VAULT', sourceType: 'PURCHASE', avgCostPerGram: 0,
  };
}

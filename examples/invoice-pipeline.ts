import { FlowForge } from "@karzoun/flowforge";

const forge = new FlowForge({
  onEvent: (event) => console.log(JSON.stringify(event)),
});

const result = await forge.run({
  id: "invoice-pipeline",
  steps: [
    {
      id: "load-invoice",
      run: async () => ({ invoiceId: "INV-42", total: 199 }),
    },
    {
      id: "charge",
      dependsOn: ["load-invoice"],
      idempotencyKey: "INV-42:charge",
      retry: { attempts: 3, backoffMs: 250, factor: 2, maxBackoffMs: 2_000 },
      timeoutMs: 5_000,
      run: async ({ context, signal }) => {
        signal.throwIfAborted();
        const invoice = context["load-invoice"] as { invoiceId: string; total: number };
        return { chargeId: "CH-42", invoiceId: invoice.invoiceId, amount: invoice.total };
      },
    },
    {
      id: "send-receipt",
      dependsOn: ["charge"],
      run: async ({ context }) => {
        const charge = context.charge as { chargeId: string };
        return { delivered: true, chargeId: charge.chargeId };
      },
    },
  ],
});

console.log(result);

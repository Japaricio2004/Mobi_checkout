type BrickController = { unmount: () => void | Promise<void> };

// The SDK shares the container across mounts, so creation and disposal must finish in order.
let lifecycle: Promise<void> = Promise.resolve();

export function mountCardBrick(
  create: () => Promise<BrickController>,
  onError: (error: unknown) => void,
): () => void {
  let cancelled = false;
  let controller: BrickController | null = null;
  const dispose = async () => {
    const active = controller;
    controller = null;
    await active?.unmount();
  };

  lifecycle = lifecycle.then(async () => {
    // React StrictMode cancels its first effect before this task starts.
    if (cancelled) return;
    controller = await create();
    if (cancelled) await dispose();
  }).catch((error: unknown) => {
    if (!cancelled) onError(error);
    else console.error('Mercado Pago: error al desmontar el formulario.', error);
  });

  return () => {
    cancelled = true;
    lifecycle = lifecycle.then(dispose).catch((error: unknown) => {
      console.error('Mercado Pago: error al desmontar el formulario.', error);
    });
  };
}

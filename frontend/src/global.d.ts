interface Window {
  deviceId?: string;
  MP_DEVICE_SESSION_ID?: string;
  MercadoPago?: new (publicKey: string, options?: { locale?: string }) => {
    bricks: () => {
      create: (brick: string, containerId: string, settings: Record<string, unknown>) => Promise<{ unmount: () => void | Promise<void> }>;
    };
    yape: (options: { otp: string; phoneNumber: string }) => { create: () => Promise<{ id?: string } | string> };
  };
}

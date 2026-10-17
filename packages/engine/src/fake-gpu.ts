/** Minimal WebGPU stand-ins for unit tests that run without a GPU. */

export class FakeTexture {
  destroyed = false;
  constructor(readonly descriptor: GPUTextureDescriptor) {}
  destroy(): void {
    this.destroyed = true;
  }
}

export class FakeDevice {
  readonly textures: FakeTexture[] = [];
  readonly writes: { texture: FakeTexture; data: Uint8ClampedArray }[] = [];
  readonly lost: Promise<GPUDeviceLostInfo>;
  destroyed = false;
  #resolveLost: (info: GPUDeviceLostInfo) => void = () => {};

  constructor(readonly descriptor: GPUDeviceDescriptor | undefined) {
    this.lost = new Promise((resolve) => {
      this.#resolveLost = resolve;
    });
  }

  readonly queue = {
    writeTexture: (destination: { texture: FakeTexture }, data: Uint8ClampedArray) => {
      this.writes.push({ texture: destination.texture, data });
    },
  };

  createTexture(descriptor: GPUTextureDescriptor): FakeTexture {
    const texture = new FakeTexture(descriptor);
    this.textures.push(texture);
    return texture;
  }

  destroy(): void {
    this.destroyed = true;
    this.#resolveLost({ reason: "destroyed", message: "" } as GPUDeviceLostInfo);
  }

  /** Simulates a driver reset or GPU process crash. */
  lose(): void {
    this.#resolveLost({ reason: "unknown", message: "lost" } as GPUDeviceLostInfo);
  }

  get gpu(): GPUDevice {
    return this as unknown as GPUDevice;
  }
}

export interface FakeAdapterOptions {
  description?: string;
  isFallbackAdapter?: boolean;
  failDevice?: boolean;
}

export class FakeAdapter {
  readonly devices: FakeDevice[] = [];
  readonly info: Partial<GPUAdapterInfo>;
  readonly features = new Set(["timestamp-query", "shader-f16"]);
  readonly limits = {
    maxTextureDimension2D: 16384,
    maxBufferSize: 2 ** 31,
    maxStorageBufferBindingSize: 2 ** 30,
    maxComputeWorkgroupStorageSize: 32768,
  };

  constructor(readonly options: FakeAdapterOptions = {}) {
    this.info = {
      vendor: "acme",
      architecture: "rdna",
      device: "",
      description: options.description ?? "Acme(R) Graphics(TM)",
      isFallbackAdapter: options.isFallbackAdapter ?? false,
    };
  }

  async requestDevice(descriptor?: GPUDeviceDescriptor): Promise<FakeDevice> {
    if (this.options.failDevice) throw new Error("device creation failed");
    const device = new FakeDevice(descriptor);
    this.devices.push(device);
    return device;
  }
}

/** A `navigator.gpu` stand-in returning `adapter()` for every request. */
export class FakeGpu {
  readonly requests: (GPURequestAdapterOptions | undefined)[] = [];
  constructor(public adapter: () => FakeAdapter | null) {}

  async requestAdapter(options?: GPURequestAdapterOptions): Promise<FakeAdapter | null> {
    this.requests.push(options);
    return this.adapter();
  }

  get gpu(): GPU {
    return this as unknown as GPU;
  }
}

import { OptionsController } from '../../src/ui/options-controller';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('options-form') as HTMLFormElement | null;
  const urlInput = document.getElementById('daemon-url') as HTMLInputElement | null;
  const tokenInput = document.getElementById('api-token') as HTMLInputElement | null;
  const pacingInput = document.getElementById('pacing-seconds') as HTMLInputElement | null;
  const jitterInput = document.getElementById('jitter-ratio') as HTMLInputElement | null;
  const testBtn = document.getElementById('test-connection-btn') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('save-options-btn') as HTMLButtonElement | null;
  const nativeBtn = document.getElementById('native-bootstrap-btn') as HTMLButtonElement | null;
  const statusBanner = document.getElementById('connection-status');
  const nativeStatusEl = document.getElementById('native-host-status');

  if (
    !form ||
    !urlInput ||
    !tokenInput ||
    !pacingInput ||
    !jitterInput ||
    !testBtn ||
    !saveBtn ||
    !nativeBtn ||
    !statusBanner ||
    !nativeStatusEl
  ) {
    return;
  }

  const controller = new OptionsController({
    form,
    urlInput,
    tokenInput,
    pacingInput,
    jitterInput,
    testBtn,
    saveBtn,
    nativeBtn,
    statusBanner,
    nativeStatusEl,
  });

  void controller.init();
});

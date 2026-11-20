import type { Locator, Page } from '@playwright/test';
import type { ExtensionContextHandle } from './extension.ts';

export interface ExtensionPages {
  openOptions(): Promise<Page>;
  openSidePanel(): Promise<Page>;
  openPopup(): Promise<Page>;
  getShadowToolbar(upworkPage: Page): Locator;
}

export function createExtensionPages(ext: ExtensionContextHandle): ExtensionPages {
  const openRelativePage = async (relativePath: string | null, label: string): Promise<Page> => {
    if (relativePath === null) {
      throw new Error(
        `Extension ${label} entrypoint is not declared in .output/chrome-mv3/manifest.json`,
      );
    }
    const page = await ext.context.newPage();
    await page.goto(ext.getExtensionUrl(relativePath), { waitUntil: 'domcontentloaded' });
    return page;
  };

  return {
    openOptions(): Promise<Page> {
      return openRelativePage(ext.manifest.optionsPath, 'options_ui');
    },
    openSidePanel(): Promise<Page> {
      return openRelativePage(ext.manifest.sidePanelPath, 'side_panel');
    },
    openPopup(): Promise<Page> {
      return openRelativePage(ext.manifest.popupPath, 'action.default_popup');
    },
    getShadowToolbar(upworkPage: Page): Locator {
      return upworkPage.locator('upwork-buddy-ui, #upwork-buddy-button-container').first();
    },
  };
}

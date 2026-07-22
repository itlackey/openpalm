export type PwaInstallStatus =
	| 'idle'
	| 'available'
	| 'prompting'
	| 'accepted'
	| 'dismissed'
	| 'installed'
	| 'ios';

type InstallChoice = { outcome: 'accepted' | 'dismissed' };
type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<InstallChoice>;
};
type NavigatorWithStandalone = Navigator & { standalone?: boolean };

class PwaInstallService {
	status = $state<PwaInstallStatus>('idle');

	#initialized = false;
	#installPrompt: BeforeInstallPromptEvent | null = null;
	#displayMode: MediaQueryList | null = null;

	#handleBeforeInstallPrompt = (event: Event): void => {
		if (this.#isStandalone()) return;
		event.preventDefault();
		this.#installPrompt = event as BeforeInstallPromptEvent;
		this.status = 'available';
	};

	#handleInstalled = (): void => {
		this.#installPrompt = null;
		this.status = 'installed';
	};

	#handleDisplayModeChange = (): void => {
		if (this.#isStandalone()) {
			this.#handleInstalled();
		} else if (this.#installPrompt) {
			this.status = 'available';
		} else {
			this.#showFallback();
		}
	};

	init(): void {
		if (typeof window === 'undefined' || this.#initialized) return;

		this.#displayMode = window.matchMedia('(display-mode: standalone)');
		window.addEventListener('beforeinstallprompt', this.#handleBeforeInstallPrompt);
		window.addEventListener('appinstalled', this.#handleInstalled);
		this.#displayMode.addEventListener('change', this.#handleDisplayModeChange);
		this.#initialized = true;
		this.#handleDisplayModeChange();
	}

	dispose(): void {
		if (!this.#initialized) return;

		window.removeEventListener('beforeinstallprompt', this.#handleBeforeInstallPrompt);
		window.removeEventListener('appinstalled', this.#handleInstalled);
		this.#displayMode?.removeEventListener('change', this.#handleDisplayModeChange);
		this.#displayMode = null;
		this.#installPrompt = null;
		this.#initialized = false;
		this.status = 'idle';
	}

	async prompt(): Promise<void> {
		const currentPrompt = this.#installPrompt;
		if (!currentPrompt) return;

		this.status = 'prompting';
		this.#installPrompt = null;
		try {
			await currentPrompt.prompt();
			const choice = await currentPrompt.userChoice;
			if (!this.#installationCompleted()) this.status = choice.outcome;
		} catch {
			if (!this.#installationCompleted()) this.#showFallback();
		}
	}

	#installationCompleted(): boolean {
		return this.status === 'installed';
	}

	#isStandalone(): boolean {
		const navigatorWithStandalone = navigator as NavigatorWithStandalone;
		return this.#displayMode?.matches === true || navigatorWithStandalone.standalone === true;
	}

	#showFallback(): void {
		this.status = this.#isIosSafari() ? 'ios' : 'idle';
	}

	#isIosSafari(): boolean {
		const navigatorWithStandalone = navigator as NavigatorWithStandalone;
		const isIos =
			/iPad|iPhone|iPod/.test(navigator.userAgent) ||
			(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
		const isSafari =
			/Safari/i.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);
		return isIos && isSafari && navigatorWithStandalone.standalone !== true;
	}
}

export const pwaInstallService = new PwaInstallService();

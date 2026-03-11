class NoSkipReporter {
  constructor() {
    this.skipped = [];
  }

  onTestEnd(test, result) {
    if (result.status === 'skipped') {
      this.skipped.push(test.titlePath().join(' > '));
    }
  }

  onEnd() {
    if (process.env.PW_ENFORCE_NO_SKIP !== '1') {
      return;
    }

    if (this.skipped.length === 0) {
      return;
    }

    const preview = this.skipped.slice(0, 10).map((title) => ` - ${title}`).join('\n');
    const suffix = this.skipped.length > 10 ? `\n - ...and ${this.skipped.length - 10} more` : '';
    throw new Error(
      `No-skip policy violated: ${this.skipped.length} test(s) were skipped.\n` +
      `Use bun run admin:test:e2e from repo root (sets required env).\n` +
      `Skipped tests:\n${preview}${suffix}`
    );
  }
}

export default NoSkipReporter;

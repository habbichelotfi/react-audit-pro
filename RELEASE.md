# Release guide

1. Update the version:

   ```bash
   npm version patch
   ```

   Use `minor` or `major` when the changes require it.

2. Run the complete validation suite:

   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

3. Inspect the package contents before publishing:

   ```bash
   npm pack --dry-run
   ```

4. Publish the package:

   ```bash
   npm publish --access public
   ```

5. Push the version commit and tag:

   ```bash
   git push --follow-tags
   ```


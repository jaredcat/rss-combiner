# Contributing to RSS Combiner

Thank you for your interest in contributing to the RSS Combiner template! This guide will help you get started.

## Development Setup

1. **Fork and Clone**

   ```bash
   git clone https://github.com/your-username/rss-combiner.git
   cd rss-combiner
   ```

2. **Install Dependencies**

   ```bash
   bun install
   ```

3. **Set up Test Environment**
   - Copy `wrangler.toml` and add some test RSS feeds
   - Optionally add a test `cover.jpg` image to test upload functionality
   - Test locally with `bun run dev`

## How to Contribute

### Reporting Issues

- Use the GitHub issue tracker
- Include clear reproduction steps
- Provide relevant error messages and logs
- Mention your Cloudflare Workers/R2 setup if relevant

### Suggesting Features

- Check existing issues first
- Open an issue with the "enhancement" label
- Describe the use case and expected behavior
- Consider backward compatibility

### Contributing Code

1. **Create a Feature Branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Your Changes**
   - Follow existing code style
   - Add comments for complex logic
   - Test your changes locally

3. **Test Your Changes**

   ```bash
   # Test feed generation
   bun run generate

   # Test worker locally
   bun run dev

   # Check setup script
   bun run setup

   # Test cover upload (if working with image features)
   bun run upload-cover
   ```

4. **Submit a Pull Request**
   - Write a clear description of your changes
   - Reference related issues
   - Include any breaking changes in the description

## Code Style Guidelines

- Use TypeScript for all new code
- Follow existing naming conventions
- Add JSDoc comments for public functions
- Keep functions focused and single-purpose

## Areas for Contribution

### High Priority

- Improved error handling and logging
- Better feed parsing for edge cases
- Performance optimizations
- Additional RSS feed features support

### Medium Priority

- CLI tool for easier setup
- Support for more feed formats (Atom, etc.)
- Feed validation and health checks
- Template customization options
- Enhanced image management features

### Documentation

- Improve README with more examples
- Add troubleshooting guide
- Create video tutorials
- Document advanced configuration options

## Testing

When contributing code changes:

1. **Local Testing**
   - Test with various RSS feed types
   - Verify worker functionality with `bun run dev`
   - Check XML output with `bun run generate`

2. **Image Upload Testing**
   - Test `bun run upload-cover` with different image formats
   - Verify R2 bucket integration
   - Check wrangler.toml updates correctly

3. **Edge Cases**
   - Empty feeds
   - Malformed XML
   - Network timeouts
   - Large feeds with many episodes
   - Missing cover images
   - R2 permission issues

4. **Template Testing**
   - Test the template setup process
   - Verify example configurations work
   - Check that placeholders are clear

## Release Process

For maintainers:

1. Update version in `package.json`
2. Update CHANGELOG.md (if we create one)
3. Create a GitHub release
4. Update template documentation if needed

## Questions?

- Open an issue for questions about contributing
- Check existing issues and PRs first
- Be respectful and constructive in all interactions

Thank you for helping make RSS Combiner better for everyone! 🚀

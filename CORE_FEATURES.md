# WAHA Core Features

This document describes the features that have been implemented in WAHA Core version, making them available without requiring the Plus version.

## Newly Implemented Core Features

The following features were previously restricted to WAHA Plus but are now fully implemented and available in WAHA Core:

### 1. Media Conversion

**Location**: [src/core/media/IConverter.ts](src/core/media/IConverter.ts)

The Core version now includes full media conversion capabilities using ffmpeg:

- **Voice Message Conversion**: Converts audio files to OGG/Opus format (64k bitrate) for WhatsApp voice messages
- **Video Conversion**: Converts video files to MP4 format with H.264 video codec and AAC audio codec, optimized for streaming (`faststart` flag)

**System Requirements**:
- `ffmpeg` - already included in Docker image (see [Dockerfile:96](Dockerfile#L96))
- `libvips` - for image processing and thumbnails (see [Dockerfile:99-101](Dockerfile#L99-L101))
- `opustags` - for audio metadata cleanup (see [Dockerfile:180-194](Dockerfile#L180-L194))

### 2. Profile Picture Management

**Locations**:
- NOWEB engine: [src/core/engines/noweb/session.noweb.core.ts](src/core/engines/noweb/session.noweb.core.ts)
- WEBJS engine: [src/core/engines/webjs/session.webjs.core.ts](src/core/engines/webjs/session.webjs.core.ts)
- GOWS engine: [src/core/engines/gows/session.gows.core.ts](src/core/engines/gows/session.gows.core.ts)

All three WhatsApp engines now support:
- **Setting Profile Picture**: Upload and set profile pictures from binary data or remote URLs
- **Deleting Profile Picture**: Remove the current profile picture

Supported for both personal accounts and groups.

### 3. Media Sending Capabilities

All three engines (NOWEB, WEBJS, GOWS) now fully support sending media with the following methods:

- **Send Images**: Send images with optional captions and mentions
  - Supports both remote URLs and base64-encoded binary data
  - Automatic MIME type detection
  - Support for replies and mentions

- **Send Files**: Send any file type as a document
  - Custom filenames supported
  - Automatic MIME type detection
  - Support for captions and mentions

- **Send Voice Messages**: Send audio as voice messages
  - Automatic conversion to WhatsApp-compatible format (OGG/Opus)
  - Support for replies and mentions

The implementation includes proper file handling for both:
- `RemoteFile`: Files fetched from URLs
- `BinaryFile`: Files provided as base64-encoded data

### 4. Link Preview Customization

**Engine**: NOWEB (Baileys)
**Location**: [src/core/engines/noweb/session.noweb.core.ts](src/core/engines/noweb/session.noweb.core.ts)

Send text messages with custom link previews:
- Custom title, description, and thumbnail
- Automatic URL detection and preview generation
- Fallback to standard text messages if preview generation fails

### 5. Health Check Service

**Location**: [src/core/health/WAHAHealthCheckServiceCore.ts](src/core/health/WAHAHealthCheckServiceCore.ts)

Enhanced health monitoring with session statistics:
- Total number of active sessions
- Number of working/connected sessions
- Detailed session status information
- Follows standard health check format (status, info, error, details)

## Engine-Specific Implementations

### NOWEB Engine (Baileys)
- Profile picture management
- Image, file, and voice sending
- Custom link previews
- Full media conversion support

### WEBJS Engine (whatsapp-web.js)
- Profile picture management via MessageMedia API
- Image, file, and voice sending with MessageMedia wrapper
- Full media conversion support

### GOWS Engine (Go WhatsApp Server)
- Profile picture management via gRPC protocol
- Image, file, and voice sending with Protocol Buffers
- Full media conversion support

## Features Still Requiring Plus Version

The following features remain exclusive to WAHA Plus as they require additional implementation:

### Status (Stories) Methods
- `sendImageStatus`: Send image status updates
- `sendVoiceStatus`: Send voice status updates
- `sendVideoStatus`: Send video status updates

### Channel Methods
- `searchChannelsByView`: Search channels by view count
- `searchChannelsByText`: Search channels by text query
- `searchChannelsByCountry`: Search channels by country
- `searchChannelsByCategory`: Search channels by category
- `previewChannelMessages`: Preview messages from a channel
- `getCategories`: Get available channel categories
- `getViews`: Get available channel view filters

### Interactive Messages (WEBJS)
- `sendButtonsReply`: Send messages with button interactions

### Interactive Messages (GOWS)
- `sendPollVote`: Vote on polls
- `sendList`: Send list messages
- `sendLinkCustomPreview`: Send messages with custom link previews

### Interactive Messages (NOWEB)
- `sendList`: Send list messages

## System Dependencies

All required system dependencies are already included in the Docker image:

```dockerfile
# Media conversion
RUN apt-get install -y ffmpeg

# Image processing for thumbnails
RUN apt-get install -y libvips

# Audio metadata cleanup
# opustags built from source (v1.10.1)
```

For local development, ensure you have:
- Node.js >= 22 (see [.nvmrc](.nvmrc))
- ffmpeg installed on your system
- libvips development libraries

## API Documentation

All implemented features are automatically documented in the OpenAPI/Swagger interface available at:
- Local: `http://localhost:3000/`
- Example: https://waha.devlike.pro/swagger

The Swagger documentation is auto-generated from code decorators, so all newly available endpoints are automatically included with proper request/response schemas.

## Migration Notes

If you were previously using WAHA Plus for these features, you can now:
1. Switch to WAHA Core (`devlikeapro/waha`)
2. All media sending, profile picture, and conversion features will continue to work
3. Health checks now include session statistics by default
4. No code changes required - API endpoints remain the same

## Contributing

To implement additional features currently in Plus version:
1. Locate the service/method throwing `AvailableInPlusVersion`
2. Implement the actual functionality
3. Ensure all required system dependencies are documented
4. Test across all three engines (NOWEB, WEBJS, GOWS)
5. Update this documentation

## Related Files

- Exception definitions: [src/core/exceptions.ts](src/core/exceptions.ts)
- Base session class: [src/core/abc/session.abc.ts](src/core/abc/session.abc.ts)
- Swagger configuration: [src/core/SwaggerConfiguratorCore.ts](src/core/SwaggerConfiguratorCore.ts)
- Docker image: [Dockerfile](Dockerfile)

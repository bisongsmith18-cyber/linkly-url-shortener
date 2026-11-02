const errorResponse = {
  description: 'The request could not be completed',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
};

const codeParameter = { $ref: '#/components/parameters/Code' };
const linkResponse = {
  description: 'Link details',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Link' },
    },
  },
};
const clickPageResponse = {
  description: 'A page of click records and the next page cursor',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ClickPage' },
    },
  },
};

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Linkly URL shortener',
    version: '1.0.0',
    description: 'Create short links, redirect visitors, and inspect click analytics.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/health': {
      get: {
        summary: 'Check API and database health',
        responses: {
          200: {
            description: 'Database is available',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  properties: { status: { type: 'string', example: 'ok' } },
                },
              },
            },
          },
          503: { ...errorResponse, description: 'Database is unavailable' },
        },
      },
    },
    '/links': {
      post: {
        summary: 'Create a short link',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['target_url'],
                additionalProperties: false,
                properties: {
                  target_url: {
                    type: 'string',
                    format: 'uri',
                    description: 'A URL starting with http:// or https://',
                  },
                  expires_at: {
                    type: 'string',
                    format: 'date-time',
                    description: 'Optional expiry time in ISO 8601 format',
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { ...linkResponse, description: 'Short link created' },
          400: errorResponse,
          413: { ...errorResponse, description: 'Request body is too large' },
          503: { ...errorResponse, description: 'Could not generate a unique short code' },
        },
      },
    },
    '/links/{code}': {
      parameters: [codeParameter],
      get: {
        summary: 'Get link details and click count',
        responses: {
          200: linkResponse,
          404: errorResponse,
        },
      },
      delete: {
        summary: 'Delete a link and its click records',
        responses: {
          204: { description: 'Link deleted' },
          404: errorResponse,
        },
      },
    },
    '/links/{code}/clicks': {
      get: {
        summary: 'Get a page of click records',
        parameters: [
          codeParameter,
          {
            name: 'after',
            in: 'query',
            description: 'Cursor returned by the previous page',
            schema: { type: 'string' },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Number of click records to return',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        ],
        responses: {
          200: clickPageResponse,
          400: errorResponse,
          404: errorResponse,
        },
      },
    },
    '/links/{code}/clicks.csv': {
      get: {
        summary: 'Download all click records as a CSV file',
        parameters: [codeParameter],
        responses: {
          200: {
            description: 'CSV click records',
            content: { 'text/csv': { schema: { type: 'string' } } },
          },
          404: errorResponse,
        },
      },
    },
    '/{code}': {
      get: {
        summary: 'Redirect to the target and record a click',
        parameters: [codeParameter],
        responses: {
          302: {
            description: 'Redirected to the target URL',
            headers: { Location: { schema: { type: 'string', format: 'uri' } } },
          },
          404: errorResponse,
          410: errorResponse,
        },
      },
    },
  },
  components: {
    parameters: {
      Code: {
        name: 'code',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,16}$' },
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: { type: 'string' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              required: ['field', 'message'],
              properties: {
                field: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      Link: {
        type: 'object',
        required: ['code', 'target_url', 'created_at', 'expires_at', 'click_count'],
        properties: {
          code: { type: 'string' },
          target_url: { type: 'string', format: 'uri' },
          created_at: { type: 'string', format: 'date-time' },
          expires_at: { type: 'string', format: 'date-time', nullable: true },
          click_count: { type: 'integer', minimum: 0 },
          short_url: { type: 'string', format: 'uri-reference' },
        },
      },
      Click: {
        type: 'object',
        required: ['id', 'clicked_at', 'referrer', 'user_agent'],
        properties: {
          id: { type: 'integer' },
          clicked_at: { type: 'string', format: 'date-time' },
          referrer: { type: 'string', nullable: true },
          user_agent: { type: 'string', nullable: true },
        },
      },
      ClickPage: {
        type: 'object',
        required: ['items', 'next_cursor'],
        properties: {
          items: { type: 'array', items: { $ref: '#/components/schemas/Click' } },
          next_cursor: { type: 'string', nullable: true },
        },
      },
    },
  },
};

import { z } from 'zod';
import {
  PriorityAvailabilitySchema,
  PriorityContextSchema,
  PriorityOrderPageSchema,
  PriorityOrderSchema,
  type PriorityOrderInput,
  type PriorityStatusInput,
} from '@idosi/contracts';
import { requestJson } from '../../lib/http-request';
import { ApiClientError } from '../../lib/api';

const read = (path: string) => requestJson(`/priority-orders${path}`, undefined, ApiClientError);
export const priorityApi = {
  context: async (storeId: string, page = 1) =>
    z
      .object({ data: PriorityContextSchema })
      .parse(await read(`/context${storeId ? `?storeId=${storeId}&page=${page}` : ''}`)).data,
  availability: async (storeId: string, productId: string) =>
    z
      .object({ data: PriorityAvailabilitySchema })
      .parse(await read(`/availability?storeId=${storeId}&productId=${productId}`)).data,
  list: async (page: number, storeId = '') =>
    PriorityOrderPageSchema.parse(
      await read(`?page=${page}&pageSize=20${storeId ? `&storeId=${storeId}` : ''}`),
    ),
  submit: async (input: PriorityOrderInput, key: string) =>
    z
      .object({ data: PriorityOrderSchema })
      .parse(
        await requestJson(
          '/priority-orders',
          { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(input) },
          ApiClientError,
        ),
      ).data,
  status: async (id: string, input: PriorityStatusInput, key: string) =>
    z
      .object({ data: PriorityOrderSchema })
      .parse(
        await requestJson(
          `/priority-orders/${id}/reshare-status`,
          { method: 'PUT', headers: { 'idempotency-key': key }, body: JSON.stringify(input) },
          ApiClientError,
        ),
      ).data,
};

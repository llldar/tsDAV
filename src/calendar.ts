import { DAVDepth, DAVFilter, DAVProp, DAVResponse } from 'DAVTypes';
/* eslint-disable no-underscore-dangle */
import getLogger from 'debug';
import { DAVAccount, DAVCalendar, DAVCalendarObject } from 'models';
import URL from 'url';

import { collectionQuery, smartCollectionSync, supportedReportSet } from './collection';
import { DAVNamespace, DAVNamespaceShorthandMap, ICALObjects } from './consts';
import { createObject, davRequest, deleteObject, propfind, updateObject } from './request';
import { formatFilters, formatProps, getDAVAttribute, urlEquals } from './util/requestHelpers';
import { findMissingFieldNames, hasFields } from './util/typeHelper';

const debug = getLogger('tsdav:calendar');

export const calendarQuery = async (
  url: string,
  props: DAVProp[],
  options?: {
    filters?: DAVFilter[];
    timezone?: string;
    depth?: DAVDepth;
    headers?: { [key: string]: any };
  }
): Promise<DAVResponse[]> =>
  collectionQuery(
    url,
    {
      'calendar-query': {
        _attributes: getDAVAttribute([
          DAVNamespace.CALDAV,
          DAVNamespace.CALENDAR_SERVER,
          DAVNamespace.CALDAV_APPLE,
          DAVNamespace.DAV,
        ]),
        [`${DAVNamespaceShorthandMap[DAVNamespace.DAV]}:prop`]: formatProps(props),
        filter: formatFilters(options?.filters),
        timezone: options?.timezone,
      },
    },
    { depth: options?.depth, headers: options?.headers }
  );

export const calendarMultiGet = async (
  url: string,
  props: DAVProp[],
  ObjectUrls: string[],
  options?: {
    filters?: DAVFilter[];
    timezone?: string;
    depth: DAVDepth;
    headers?: { [key: string]: any };
  }
): Promise<DAVResponse[]> =>
  collectionQuery(
    url,
    {
      'calendar-multiget': {
        _attributes: getDAVAttribute([DAVNamespace.DAV, DAVNamespace.CALDAV]),
        [`${DAVNamespaceShorthandMap[DAVNamespace.DAV]}:prop`]: formatProps(props),
        [`${DAVNamespaceShorthandMap[DAVNamespace.DAV]}:href`]: ObjectUrls,
        filter: formatFilters(options?.filters),
        timezone: options?.timezone,
      },
    },
    { depth: options?.depth, headers: options?.headers }
  );

export const makeCalendar = async (
  url: string,
  props: DAVProp[],
  options?: {
    depth: DAVDepth;
    headers?: { [key: string]: any };
  }
): Promise<DAVResponse[]> =>
  davRequest(url, {
    method: 'MKCALENDAR',
    headers: { ...options?.headers, depth: options?.depth },
    namespace: DAVNamespaceShorthandMap[DAVNamespace.DAV],
    body: {
      [`${DAVNamespaceShorthandMap[DAVNamespace.CALDAV]}:mkcalendar`]: {
        _attributes: getDAVAttribute([DAVNamespace.DAV, DAVNamespace.CALDAV]),
        set: {
          prop: formatProps(props),
        },
      },
    },
  });

export const fetchCalendars = async (options?: {
  headers?: { [key: string]: any };
  account?: DAVAccount;
}): Promise<DAVCalendar[]> => {
  const requiredFields: Array<'homeUrl' | 'rootUrl'> = ['homeUrl', 'rootUrl'];
  if (!options?.account || !hasFields(options?.account, requiredFields)) {
    if (!options?.account) {
      throw new Error('no account for fetchCalendars');
    }
    throw new Error(
      `account must have ${findMissingFieldNames(
        options.account,
        requiredFields
      )} before fetchCalendars`
    );
  }

  const { account } = options;
  const res = await propfind(
    options.account.homeUrl,
    [
      { name: 'calendar-description', namespace: DAVNamespace.CALDAV },
      { name: 'calendar-timezone', namespace: DAVNamespace.CALDAV },
      { name: 'displayname', namespace: DAVNamespace.DAV },
      { name: 'getctag', namespace: DAVNamespace.CALENDAR_SERVER },
      { name: 'resourcetype', namespace: DAVNamespace.DAV },
      { name: 'supported-calendar-component-set', namespace: DAVNamespace.CALDAV },
      { name: 'sync-token', namespace: DAVNamespace.DAV },
    ],
    { depth: 1, headers: options?.headers }
  );

  return Promise.all(
    res
      .filter((r) => Object.keys(r.props?.resourcetype ?? {}).includes('calendar'))
      .filter((rc) => {
        // filter out none iCal format calendars.
        const components: ICALObjects[] = Array.isArray(
          rc.props?.supportedCalendarComponentSet.comp
        )
          ? rc.props?.supportedCalendarComponentSet.comp.map((sc: any) => sc._attributes.name)
          : [rc.props?.supportedCalendarComponentSet.comp._attributes.name] || [];
        return components.some((c) => Object.values(ICALObjects).includes(c));
      })
      .map((rs) => {
        debug(`Found calendar ${rs.props?.displayname}`);
        return {
          description: rs.props?.calendarDescription,
          timezone: rs.props?.calendarTimezone,
          url: URL.resolve(account.rootUrl ?? '', rs.href ?? ''),
          ctag: rs.props?.getctag,
          displayName: rs.props?.displayname,
          components: Array.isArray(rs.props?.supportedCalendarComponentSet.comp)
            ? rs.props?.supportedCalendarComponentSet.comp.map((sc: any) => sc._attributes.name)
            : [rs.props?.supportedCalendarComponentSet.comp._attributes.name],
          resourcetype: Object.keys(rs.props?.resourcetype),
          syncToken: rs.props?.syncToken,
        };
      })
      .map(async (cal) => ({ ...cal, reports: await supportedReportSet(cal, options) }))
  );
};

export const fetchCalendarObjects = async (
  calendar: DAVCalendar,
  options?: { filters?: DAVFilter[]; headers?: { [key: string]: any }; account?: DAVAccount }
): Promise<DAVCalendarObject[]> => {
  debug(`Fetching calendar objects from ${calendar?.url}`);
  const requiredFields: Array<'rootUrl'> = ['rootUrl'];
  if (!options?.account || !hasFields(options?.account, requiredFields)) {
    if (!options?.account) {
      throw new Error('no account for fetchCalendarObjects');
    }
    throw new Error(
      `account must have ${findMissingFieldNames(
        options.account,
        requiredFields
      )} before fetchCalendarObjects`
    );
  }

  const filters: DAVFilter[] = options?.filters ?? [
    {
      type: 'comp-filter',
      attributes: { name: 'VCALENDAR' },
      children: [
        {
          type: 'comp-filter',
          attributes: { name: 'VEVENT' },
        },
      ],
    },
  ];
  const results = await calendarQuery(
    calendar.url,
    [
      { name: 'getetag', namespace: DAVNamespace.DAV },
      { name: 'calendar-data', namespace: DAVNamespace.CALDAV },
    ],
    { filters, depth: 1, headers: options?.headers }
  );

  // if data is already present, return
  if (results.some((res) => res.props?.calendarData?._cdata)) {
    return results.map((r) => ({
      url: URL.resolve(options?.account?.rootUrl ?? '', r.href ?? '') ?? '',
      etag: r.props?.getetag,
      data: r.props?.calendarData?._cdata,
    }));
  }

  // process to use calendar-multiget to fetch data
  const calendarObjectUrls = results.map((res) =>
    URL.resolve(options.account?.rootUrl ?? '', res.href ?? '')
  );

  const calendarObjectResults = await calendarMultiGet(
    calendar.url,
    [
      { name: 'getetag', namespace: DAVNamespace.DAV },
      { name: 'calendar-data', namespace: DAVNamespace.CALDAV },
    ],
    calendarObjectUrls,
    { depth: 1, headers: options?.headers }
  );

  return calendarObjectResults.map((res) => ({
    url: res.href ?? '',
    etag: res.props?.getetag,
    data: res.props?.calendarData,
  }));
};

export const createCalendarObject = async (
  calendar: DAVCalendar,
  iCalString: string,
  filename: string,
  options?: { headers?: { [key: string]: any } }
): Promise<Response> => {
  return createObject(URL.resolve(calendar.url, filename), iCalString, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      ...options?.headers,
    },
  });
};

export const updateCalendarObject = async (
  calendarObject: DAVCalendarObject,
  options?: { headers?: { [key: string]: any } }
): Promise<Response> => {
  return updateObject(calendarObject.url, calendarObject.data, calendarObject.etag, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      ...options?.headers,
    },
  });
};

export const deleteCalendarObject = async (
  calendarObject: DAVCalendarObject,
  options?: { headers?: { [key: string]: any } }
): Promise<Response> => {
  return deleteObject(calendarObject.url, calendarObject.etag, options);
};

/**
 * Sync remote calendars to local
 */
export const syncCalendars: {
  <
    T extends
      | {
          headers?: { [key: string]: any };
          account?: DAVAccount;
          detailResult?: T;
        }
      | undefined
  >(
    oldCalendars: DAVCalendar[],
    options?: T
  ): Promise<T extends undefined ? DAVCalendar[] : never>;
  <T extends boolean>(
    oldCalendars: DAVCalendar[],
    options?: {
      headers?: { [key: string]: any };
      account?: DAVAccount;
      detailResult?: T;
    }
  ): Promise<
    T extends true
      ? {
          created: DAVCalendar[];
          updated: DAVCalendar[];
          deleted: DAVCalendar[];
        }
      : DAVCalendar[]
  >;
  (
    oldCalendars: DAVCalendar[],
    options?: {
      headers?: { [key: string]: any };
      account?: DAVAccount;
      detailResult?: boolean;
    }
  ): Promise<
    | {
        created: DAVCalendar[];
        updated: DAVCalendar[];
        deleted: DAVCalendar[];
      }
    | DAVCalendar[]
  >;
} = async (
  oldCalendars: DAVCalendar[],
  options?: {
    headers?: { [key: string]: any };
    account?: DAVAccount;
    detailResult?: boolean;
  }
): Promise<any> => {
  if (!options?.account) {
    throw new Error('Must have account before syncCalendars');
  }
  const { account } = options;
  const localCalendars = oldCalendars ?? account.calendars ?? [];
  const remoteCalendars = await fetchCalendars({ ...options, account });

  // no existing url
  const created = remoteCalendars.filter((rc) =>
    localCalendars.every((lc) => !urlEquals(lc.url, rc.url))
  );
  debug(`new calendars: ${created.map((cc) => cc.displayName)}`);

  // have same url, but syncToken/ctag different
  const updated = localCalendars.reduce((prev, curr) => {
    const found = remoteCalendars.find((rc) => urlEquals(rc.url, curr.url));
    if (
      found &&
      ((found.syncToken && found.syncToken !== curr.syncToken) ||
        (found.ctag && found.ctag !== curr.ctag))
    ) {
      return [...prev, found];
    }
    return prev;
  }, []);
  debug(`updated calendars: ${updated.map((cc) => cc.displayName)}`);

  // does not present in remote
  const deleted = localCalendars.filter((cal) =>
    remoteCalendars.every((a) => !urlEquals(a.url, cal.url))
  );
  debug(`deleted calendars: ${deleted.map((cc) => cc.displayName)}`);

  return options?.detailResult
    ? {
        created,
        updated,
        deleted,
      }
    : [...created, ...updated];
};

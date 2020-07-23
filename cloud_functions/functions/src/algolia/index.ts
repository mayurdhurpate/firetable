import * as algoliasearch from "algoliasearch";
import * as functions from "firebase-functions";
import * as _ from "lodash";
import { env } from "../config";
import config, { collectionPath } from "../functionConfig"; // generated using generateConfig.ts
import { asyncForEach, getEventTypeOnWrite } from "../utils";
const functionConfig: any = config;

const APP_ID = env.algolia.app;
const ADMIN_KEY = env.algolia.key;

const client = algoliasearch(APP_ID, ADMIN_KEY);

const missingFieldsReducer = (data: any) => (acc: string[], curr: string) => {
  if (data[curr] === undefined) {
    return [...acc, curr];
  } else return acc;
};

const filterSnapshot = (
  field: { docPath: string; snapshot: any },
  preservedKeys: string[]
) => {
  return {
    docPath: field.docPath,
    ...preservedKeys.reduce((acc: any, currentKey: string) => {
      const value = _.get(field.snapshot, currentKey);
      if (value) {
        return { ...acc, snapshot: { [currentKey]: value, ...acc.snapshot } };
      } else return acc;
    }, {}),
  };
};

// returns object of fieldsToSync
const algoliaReducer = (docData: FirebaseFirestore.DocumentData) => (
  acc: any,
  curr: string | { fieldName: string; snapshotFields: string[] }
) => {
  if (typeof curr === "string") {
    if (docData[curr] && typeof docData[curr].toDate === "function") {
      return {
        ...acc,
        [curr]: docData[curr].toDate().getTime() / 1000,
      };
    } else if (docData[curr] !== undefined || docData[curr] !== null) {
      return { ...acc, [curr]: docData[curr] };
    } else {
      return acc;
    }
  } else {
    if (docData[curr.fieldName] && curr.snapshotFields) {
      return {
        ...acc,
        [curr.fieldName]: docData[curr.fieldName].map(snapshot =>
          filterSnapshot(snapshot, curr.snapshotFields)
        ),
      };
    } else {
      return acc;
    }
  }
};

const addToAlgolia = (
  fieldsToSync: string[],
  requiredFields: string[],
  indexName?: string
) => (snapshot: FirebaseFirestore.DocumentSnapshot) => {
  const collectionName = snapshot.ref.parent.id;
  const objectID = snapshot.id;
  const docData = snapshot.data();
  if (!docData) return false; // returns if theres no data in the doc
  const missingRequiredFields = requiredFields.reduce(
    missingFieldsReducer(docData),
    []
  );
  if (missingRequiredFields.length > 0) {
    throw new Error(
      `Missing required fields:${missingRequiredFields.join(", ")}`
    );
  }
  const algoliaData = fieldsToSync.reduce(algoliaReducer(docData), {});
  if (Object.keys(algoliaData).length === 0) return false; // returns if theres nothing to sync
  const index = client.initIndex(indexName ? indexName : collectionName); // initialize algolia index
  return index.addObject({ ...algoliaData, objectID }); // add new algolia entry
};

const updateAlgolia = (
  fieldsToSync: string[],
  requiredFields: string[],
  indexName?: string
) => async (snapshot: functions.Change<FirebaseFirestore.DocumentSnapshot>) => {
  const objectID = snapshot.after.id;
  try {
    const collectionName = snapshot.after.ref.parent.id;

    const docData = snapshot.after.data();
    if (!docData) return false; // returns if theres no data in the doc
    const missingRequiredFields = requiredFields.reduce(
      missingFieldsReducer(docData),
      []
    );
    if (missingRequiredFields.length > 0) {
      throw new Error(
        `Missing required fields:${missingRequiredFields.join(", ")}`
      );
    }
    const algoliaData = fieldsToSync.reduce(algoliaReducer(docData), {});
    if (Object.keys(algoliaData).length === 0) return false; // returns if theres nothing to sync
    const index = client.initIndex(indexName ? indexName : collectionName); // initialize algolia index
    const algoliaTask = await index.saveObject({ ...algoliaData, objectID }); // add update algolia entry
    return algoliaTask;
  } catch (error) {
    console.error(JSON.stringify({ error, objectID }));
    return false;
  }
};

const deleteFromAlgolia = (indexName?: string) => (
  snapshot: FirebaseFirestore.DocumentSnapshot
) => {
  const collectionName = snapshot.ref.parent.id;
  const objectID = snapshot.id;
  const index = client.initIndex(indexName ? indexName : collectionName); // initialize algolia index
  return index.deleteObject(objectID); // delete algolia entry
};

export const FT_algolia = {
  [functionConfig.name]: functions.firestore
    .document(`${collectionPath}/{docId}`)
    .onWrite(async (change, context) => {
      const eventType = getEventTypeOnWrite(change);
      if (functionConfig.indices) {
        // multiple indicies
        switch (eventType) {
          case "CREATE":
            await asyncForEach(functionConfig.indices, async index => {
              await addToAlgolia(
                index.fieldsToSync,
                index.requiredFields ?? []
              );
            });

            break;
          case "UPDATE":
            await asyncForEach(functionConfig.indices, async index => {
              await updateAlgolia(
                index.fieldsToSync,
                index.requiredFields ?? []
              )(change);
            });
            break;
          case "DELETE":
            await asyncForEach(functionConfig.indices, async index => {
              deleteFromAlgolia(index.name)(change.before);
            });
            break;
          default:
            break;
        }
      } else {
        switch (eventType) {
          case "CREATE":
            await addToAlgolia(
              functionConfig.fieldsToSync,
              functionConfig.requiredFields ?? []
            );
            break;
          case "UPDATE":
            await updateAlgolia(
              functionConfig.fieldsToSync,
              functionConfig.requiredFields ?? []
            )(change);
          case "DELETE":
            await deleteFromAlgolia()(change.before);
          default:
            break;
        }
      }
    }),
};

const fs = require('fs/promises');

const GRAPHQL_PRODUCT_QUERY = `
  query GetProducts($first: Int, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        status
        tracksInventory
        totalInventory
        availability_mf: metafield(namespace: "filters", key: "availability") {
          value
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const GRAPHQL_AVAILABILITY_MF_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        namespace
        value
        createdAt
        updatedAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const readProductsFromFile = async (filepath) => {
  try {
    const data = await fs.readFile(filepath, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const writeProductToFile = async (product_id, status, filepath) => {
  try {
    const products = await readProductsFromFile(filepath);
    
    // Check if product already exists, update it if so
    const existingIndex = products.findIndex(p => p.id === product_id);
    if (existingIndex >= 0) {
      products[existingIndex] = { id: product_id, status: status };
    } else {
      products.push({ id: product_id, status: status });
    }
    
    await fs.writeFile(filepath, JSON.stringify(products, null, 2), 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Failed to write product:', error.message);
    throw new Error(`Failed to write product to file: ${error.message}`);
  }
};

const queryAllProducts = async () => {
  let hasNextPage = true;
  let endCursor = null;

  while (hasNextPage) {
    const variables = {
      first: 250,
      after: endCursor
    };

    const response = await fetch(
      `https://${Bun.env.STORE}.myshopify.com/admin/api/2026-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': Bun.env.SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: GRAPHQL_PRODUCT_QUERY,
          variables: variables
        })
      }
    );

    if (!response.ok) {
      throw new Error('Shopify request failed: ' + response.statusText);
    }

    const data = await response.json();
    const products = data.data.products.nodes;

    for (const product of products) {
        if (product.status != 'ACTIVE') continue;
        if (product.tracksInventory === false) continue;
        if (product.availability_mf === null) continue;
        if (product.totalInventory <= 0 && product.availability_mf?.value == '> 8 weeks') continue;
        if (product.totalInventory > 0 && product.availability_mf?.value == 'In Stock') continue;

        await writeProductToFile(product.id, product.availability_mf?.value, './data/products.json');

        if (product.totalInventory <= 0 && product.availability_mf?.value != '> 8 weeks') {
            await updateProductMetafieldAndLog(product, '> 8 weeks');
        } else if (product.totalInventory > 0 && product.availability_mf?.value != 'In Stock') {
            await updateProductMetafieldAndLog(product, 'In Stock');
        }
    }

    const pageInfo = data.data.products.pageInfo;
    hasNextPage = pageInfo.hasNextPage;
    endCursor = pageInfo.endCursor;
  }
};

const updateProductMetafieldAndLog = async (product, status) => {
    const KEY = 'availability';
    const NAMESPACE = 'filters';


    const variables = {
        metafields: [
            {
                key: KEY,
                namespace: NAMESPACE,
                ownerId: product.id,
                type: "single_line_text_field",
                value: status
            }
        ]
    };

    const response = await fetch(
      `https://${Bun.env.STORE}.myshopify.com/admin/api/2026-01/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': Bun.env.SHOPIFY_ACCESS_TOKEN
        },
        body: JSON.stringify({
          query: GRAPHQL_AVAILABILITY_MF_SET_MUTATION,
          variables: variables
        })
      }
    );

    if (!response.ok) {
      throw new Error('Shopify metafieldsSet failed: ' + response.statusText);
    }

    const result = await response.json();

    if (result.data?.metafieldsSet?.userErrors?.length > 0) {
      console.error('Metafield update errors:', result.data.metafieldsSet.userErrors);
      return;
    }

    await writeProductToFile(product.id, status, './data/updated-products.json');

    console.log(`Successfully updated product metafield availability: ${product.id} / ${product.title} with status: ${status}`);
};

queryAllProducts();